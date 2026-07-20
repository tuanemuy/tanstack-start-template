import type { SecretManagerServiceClient } from "@google-cloud/secret-manager";

export type LoadSecretsDeps = Readonly<{
  client: SecretManagerServiceClient;
  bindings: ReadonlyArray<{
    // Fully qualified secret version name, e.g.
    // `projects/my-project/secrets/database-auth-token/versions/latest`.
    readonly secretName: string;
    readonly envVar: string;
  }>;
}>;

/**
 * Cold-start hook: fetches Secret Manager values and writes them into
 * `process.env` so downstream code (DI factories, libSQL client
 * construction) sees them via plain env-var reads.
 *
 * Existing non-empty values of `process.env[envVar]` are preserved so
 * local overrides win. Cloud Run's built-in Secret Manager mounting
 * (env / volume) usually removes the need for this loader entirely.
 */
export async function loadSecretsIntoEnv(deps: LoadSecretsDeps): Promise<void> {
  const { client, bindings } = deps;
  if (bindings.length === 0) return;

  await Promise.all(
    bindings.map(async ({ secretName, envVar }) => {
      if (process.env[envVar] !== undefined && process.env[envVar] !== "") {
        return;
      }
      const [response] = await client.accessSecretVersion({ name: secretName });
      const data = response.payload?.data;
      if (data === undefined || data === null) return;
      process.env[envVar] =
        typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    }),
  );
}
