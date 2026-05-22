import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const zoneName = config.require("zoneName");
const appHostname = config.require("appHostname");
const appUrl = config.require("appUrl");
const prefix = config.require("resourcePrefix");

const zone = new cloudflare.Zone("zone", {
  accountId,
  zone: zoneName,
});

const db = new cloudflare.D1Database(
  "db",
  {
    accountId,
    name: `${prefix}-d1`,
  },
  // D1 is the system of record — refuse accidental destroy.
  { protect: true },
);

const eventsQueue = new cloudflare.Queue("events", {
  accountId,
  name: `${prefix}-events`,
});

const dlqQueue = new cloudflare.Queue("dlq", {
  accountId,
  name: `${prefix}-events-dlq`,
});

export const zoneId = zone.id;
export const databaseId = db.id;
export const databaseName = db.name;
export const eventsQueueName = eventsQueue.name;
export const dlqQueueName = dlqQueue.name;
export const exportedAppUrl = appUrl;
export const exportedAppHostname = appHostname;
export const exportedPrefix = prefix;
