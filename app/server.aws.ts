import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import process from "node:process";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { LambdaInvokeRelayTrigger } from "@repo/core/adapters/aws/lambdaInvokeRelayTrigger";
import { loadSecretsIntoEnv } from "@repo/core/adapters/aws/secretsLoader";
import {
  createLibsqlClient,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  type AwsServerEnv,
  createAwsRequestContainer,
  readAwsRequestServerConfig,
  readAwsServerEnv,
} from "@repo/core/application/di/serverAws";
import type { RequestContainer } from "@repo/core/application/di/types";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";

// SSR and RSC are separate module graphs in the same isolate; pin the
// ALS on `globalThis` so both resolve the same store.
const ALS_SYMBOL: unique symbol = Symbol.for(
  "@tanstack-start-template/request-als",
) as never;
type AlsGlobalSlot = { [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer> };
const alsGlobal = globalThis as unknown as AlsGlobalSlot;
const storage =
  alsGlobal[ALS_SYMBOL] ?? new AsyncLocalStorage<RequestContainer>();
alsGlobal[ALS_SYMBOL] = storage;
installContainerStore({ getStore: () => storage.getStore() });

export type AppEnv = AwsServerEnv;

type LambdaFetch = (request: Request) => Promise<Response>;

type Booted = Readonly<{
  fetch: LambdaFetch;
}>;

let bootPromise: Promise<Booted> | null = null;

async function boot(): Promise<Booted> {
  // Optional Secrets Manager bootstrap. The infra stack passes the
  // secret ARNs as `DATABASE_AUTH_TOKEN_SECRET_ARN` etc.; if the env
  // var is set, the value is fetched and merged into `process.env`
  // before the libSQL client is constructed.
  const secretBindings: Array<{ secretId: string; envVar: string }> = [];
  const tokenSecretArn = process.env["DATABASE_AUTH_TOKEN_SECRET_ARN"];
  if (tokenSecretArn !== undefined && tokenSecretArn !== "") {
    secretBindings.push({
      secretId: tokenSecretArn,
      envVar: "DATABASE_AUTH_TOKEN",
    });
  }
  if (secretBindings.length > 0) {
    const secretsClient = new SecretsManagerClient({});
    await loadSecretsIntoEnv({
      client: secretsClient,
      bindings: secretBindings,
    });
  }

  const env = readAwsServerEnv();
  const logger = ConsoleLogger;

  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
  });
  const db = getDatabase(client);

  const relayFunctionName = env.RELAY_FUNCTION_NAME;
  const relayTrigger =
    relayFunctionName !== undefined
      ? new LambdaInvokeRelayTrigger({
          client: new LambdaClient({}),
          functionName: relayFunctionName,
          logger,
        })
      : undefined;

  const config = readAwsRequestServerConfig(env, {
    db,
    ...(relayTrigger !== undefined ? { relayTrigger } : {}),
  });

  const entryPromise = import("@tanstack/react-start/server-entry").then(
    (m) => m.default,
  );

  const fetch: LambdaFetch = async (request: Request): Promise<Response> => {
    const container = createAwsRequestContainer(config);
    const entry = await entryPromise;
    return storage.run(container, async () => entry.fetch(request));
  };

  return { fetch };
}

function getOrStartBoot(): Promise<Booted> {
  if (bootPromise === null) {
    bootPromise = boot().catch((cause) => {
      // Reset so the next invocation retries — a Lambda cold start that
      // fails (e.g. transient Secrets Manager outage) should not poison
      // the container forever.
      bootPromise = null;
      throw cause;
    });
  }
  return bootPromise;
}

function buildRequest(event: APIGatewayProxyEventV2): Request {
  const stage = event.requestContext.stage;
  // API Gateway HTTP API exposes the raw path under `rawPath`; the
  // `$default` stage is unprefixed, custom stages embed the stage as the
  // first segment of `rawPath`. Lambda Function URLs always use
  // `$default`.
  let path = event.rawPath || "/";
  if (stage && stage !== "$default") {
    // Only strip when the stage is a full path segment — otherwise
    // `/staging` would mangle `/staging-foo` into `-foo`.
    const prefix = `/${stage}`;
    if (path === prefix) {
      path = "/";
    } else if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length);
    }
  }
  const search = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const host =
    event.headers["host"] ??
    event.headers["Host"] ??
    event.requestContext.domainName;
  const protocol = event.headers["x-forwarded-proto"] ?? "https";
  const url = `${protocol}://${host}${path}${search}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(key, value);
  }
  if (event.cookies && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const method = event.requestContext.http.method;
  const hasBody =
    event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, "base64")
      : (event.body as string)
    : undefined;

  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

async function buildResult(
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(value);
    } else {
      headers[key] = value;
    }
  });
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body: buffer.toString("base64"),
    isBase64Encoded: true,
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const booted = await getOrStartBoot();
  const request = buildRequest(event);
  const response = await booted.fetch(request);
  return buildResult(response);
};

export default { handler };
