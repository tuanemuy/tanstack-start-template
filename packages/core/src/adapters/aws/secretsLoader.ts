import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export type LoadSecretsDeps = Readonly<{
  client: SecretsManagerClient;
  bindings: ReadonlyArray<{
    readonly secretId: string;
    readonly envVar: string;
  }>;
}>;

/**
 * Cold-start hook: writes Secrets Manager values into `process.env` so
 * downstream code can read them as plain env vars. A non-empty existing
 * env value wins over the secret (local overrides for migrations etc).
 * `SecretString` is read as JSON `{ [envVar]: string }` if it parses to
 * that shape, otherwise used verbatim (e.g. `turso db tokens create`).
 */
export async function loadSecretsIntoEnv(deps: LoadSecretsDeps): Promise<void> {
  const { client, bindings } = deps;
  if (bindings.length === 0) return;

  await Promise.all(
    bindings.map(async ({ secretId, envVar }) => {
      if (process.env[envVar] !== undefined && process.env[envVar] !== "") {
        return;
      }
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      const raw = response.SecretString;
      if (raw === undefined) return;

      let value = raw;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null && envVar in parsed) {
          const candidate = (parsed as Record<string, unknown>)[envVar];
          if (typeof candidate === "string") {
            value = candidate;
          }
        }
      } catch {
        // Not JSON — fall through and use the raw `SecretString`.
      }

      process.env[envVar] = value;
    }),
  );
}
