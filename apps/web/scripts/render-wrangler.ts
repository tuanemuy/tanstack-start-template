#!/usr/bin/env tsx
/**
 * Render `wrangler.<stage>.toml` from a `.tpl` template by substituting
 * placeholders with outputs from the Cloudflare resources Pulumi stack.
 *
 * Usage:
 *   pnpm tsx scripts/render-wrangler.ts <stage>
 *
 * Placeholders recognised in the template (any `${NAME}` occurrence is
 * substituted; unknown names abort the run so we never ship a half-rendered
 * config):
 *   ${APP_URL}            — public URL of the deployment
 *   ${D1_DATABASE_ID}     — D1 database id
 *   ${D1_DATABASE_NAME}   — D1 database name
 *   ${EVENTS_QUEUE_NAME}  — primary events queue name
 *   ${DLQ_QUEUE_NAME}     — dead-letter queue name
 *   ${RESOURCE_PREFIX}    — worker / resource name prefix (e.g. `…-staging`)
 *
 * Pulumi outputs are read via `pulumi -C <dir> -s <stage> stack output --json`
 * — the CLI must already be authenticated and the resources stack already
 * `pulumi up`-ed for the target stage.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_STAGES = ["staging", "production"] as const;
type Stage = (typeof SUPPORTED_STAGES)[number];

function isStage(value: string): value is Stage {
  return (SUPPORTED_STAGES as readonly string[]).includes(value);
}

const stageArg = process.argv[2];
if (stageArg === undefined || !isStage(stageArg)) {
  console.error(`usage: render-wrangler.ts <${SUPPORTED_STAGES.join("|")}>`);
  process.exit(1);
}
const stage: Stage = stageArg;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const resourcesDir = resolve(repoRoot, "infra/cloudflare/pulumi/resources");
const templatePath = resolve(webRoot, `wrangler.${stage}.toml.tpl`);
const outPath = resolve(webRoot, `wrangler.${stage}.toml`);

const raw = execFileSync(
  "pulumi",
  [
    "-C",
    resourcesDir,
    "-s",
    stage,
    "stack",
    "output",
    "--json",
    "--show-secrets",
  ],
  { encoding: "utf8" },
);
const outputs = JSON.parse(raw) as Record<string, string>;

const substitutions: Record<string, string | undefined> = {
  APP_URL: outputs.exportedAppUrl,
  D1_DATABASE_ID: outputs.databaseId,
  D1_DATABASE_NAME: outputs.databaseName,
  EVENTS_QUEUE_NAME: outputs.eventsQueueName,
  DLQ_QUEUE_NAME: outputs.dlqQueueName,
  RESOURCE_PREFIX: outputs.exportedPrefix,
};

const template = readFileSync(templatePath, "utf8");
const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
  const value = substitutions[name];
  if (value === undefined) {
    throw new Error(
      `Unknown placeholder \${${name}} in ${templatePath}. ` +
        `Known: ${Object.keys(substitutions).join(", ")}`,
    );
  }
  return value;
});

writeFileSync(outPath, rendered);
console.log(`wrote ${outPath}`);
