#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { AppStack } from "../lib/appStack.js";

const app = new App();

const account = process.env["CDK_DEFAULT_ACCOUNT"];
const region = process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";

const stages = ["staging", "production"] as const;

for (const stage of stages) {
  // Stage-keyed env vars: `TURSO_URL_STAGING`, `TURSO_AUTH_TOKEN_SECRET_ARN_STAGING`, `APP_URL_STAGING`, etc.
  const upper = stage.toUpperCase();
  const tursoUrl = process.env[`TURSO_URL_${upper}`];
  const tursoAuthSecretArn =
    process.env[`TURSO_AUTH_TOKEN_SECRET_ARN_${upper}`];
  const appUrl = process.env[`APP_URL_${upper}`];

  if (
    tursoUrl === undefined ||
    tursoAuthSecretArn === undefined ||
    appUrl === undefined
  ) {
    // Skip stages that have not been configured yet — synth stays
    // useful for the stage(s) that are wired up.
    continue;
  }

  new AppStack(app, `AppStack-${stage}`, {
    env: { ...(account !== undefined ? { account } : {}), region },
    stage,
    tursoUrl,
    tursoAuthSecretArn,
    appUrl,
  });
}
