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
 * Cold-start hook: pre-fetches Secrets Manager values and writes them
 * into `process.env` so downstream code (DI factories, libSQL client
 * construction) sees them via plain env-var reads.
 *
 * For each `{ secretId, envVar }` binding:
 *  1. If `process.env[envVar]` is already set to a non-empty value, the
 *     binding is skipped — local overrides (e.g. `.env.aws` for
 *     migrations) win over the production secret. To force a refresh
 *     from Secrets Manager (e.g. after rotation in a long-lived dev
 *     shell), unset the env var before invoking the loader.
 *  2. Otherwise `secretId` (ARN or name) is fetched via
 *     `GetSecretValueCommand`.
 *  3. The `SecretString` is interpreted as follows:
 *     - **JSON object whose `envVar` key has a string value** → that
 *       value is used. This is the canonical shape for rotation-enabled
 *       secrets where the secret stores `{ DATABASE_AUTH_TOKEN: "..." }`.
 *     - **Any other JSON shape (array, number, JSON with missing key)
 *       or plain non-JSON string** → the raw `SecretString` is used
 *       verbatim. This is the form `turso db tokens create` produces.
 *
 * Adapters that need different parsing (e.g. RDS-style
 * `{ username, password }`) should not extend this function — write a
 * dedicated loader instead.
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
