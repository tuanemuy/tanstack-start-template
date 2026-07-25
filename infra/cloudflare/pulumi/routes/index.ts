import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const resourcesStackRef = config.require("resourcesStackRef");

const resources = new pulumi.StackReference(resourcesStackRef);
const zoneId = resources.requireOutput("zoneId");
const appHostname = resources.requireOutput("exportedAppHostname");
const prefix = resources.requireOutput("exportedPrefix");

// Custom Domain binding for the primary Worker. Cloudflare resolves the
// service name eagerly — `wrangler deploy` must have run first.
new cloudflare.WorkersDomain("app", {
  accountId,
  zoneId,
  hostname: appHostname,
  service: prefix,
  environment: "production",
});

export const boundHostname = appHostname;
