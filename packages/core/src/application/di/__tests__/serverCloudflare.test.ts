import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from "@repo/core/application/workers/eventRelayWorker";
import { DEFAULT_OUTBOX_RETENTION_MS } from "@repo/core/application/workers/outboxPrune";
import { describe, expect, it } from "vitest";
import {
  readPruneTuning,
  readRelayTuning,
  type ServerEnv,
} from "../serverCloudflare";

// Tuning readers sit at the wrangler-vars transport boundary. The
// production path supplies validated values from `[env.relay.vars]` /
// `[env.pruner.vars]`; tests and local dev rely on the defaults
// exported by the application-layer worker modules.

function envWith(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    DB: {} as ServerEnv["DB"],
    APP_URL: "http://localhost:8787",
    ...overrides,
  };
}

describe("readRelayTuning", () => {
  it("falls back to application-layer defaults when no env vars are set", () => {
    const tuning = readRelayTuning(envWith());
    expect(tuning).toEqual({
      batchSize: DEFAULT_BATCH_SIZE,
      leaseMs: DEFAULT_LEASE_MS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
  });

  it("coerces string vars from wrangler [vars] to numbers", () => {
    const tuning = readRelayTuning(
      envWith({
        OUTBOX_BATCH_SIZE: "50",
        OUTBOX_LEASE_MS: "120000",
        OUTBOX_MAX_ATTEMPTS: "5",
      }),
    );
    expect(tuning).toEqual({
      batchSize: 50,
      leaseMs: 120_000,
      maxAttempts: 5,
    });
  });

  it("rejects non-positive batch size", () => {
    expect(() =>
      readRelayTuning(envWith({ OUTBOX_BATCH_SIZE: "0" })),
    ).toThrow();
    expect(() =>
      readRelayTuning(envWith({ OUTBOX_BATCH_SIZE: "-1" })),
    ).toThrow();
  });

  it("rejects non-positive lease", () => {
    expect(() => readRelayTuning(envWith({ OUTBOX_LEASE_MS: "0" }))).toThrow();
  });

  it("rejects maxAttempts below 1", () => {
    expect(() =>
      readRelayTuning(envWith({ OUTBOX_MAX_ATTEMPTS: "0" })),
    ).toThrow();
  });

  it("rejects non-numeric strings", () => {
    expect(() =>
      readRelayTuning(envWith({ OUTBOX_BATCH_SIZE: "abc" })),
    ).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() =>
      readRelayTuning(envWith({ OUTBOX_BATCH_SIZE: "10.5" })),
    ).toThrow();
  });
});

describe("readPruneTuning", () => {
  it("falls back to the application-layer default when no env var is set", () => {
    const tuning = readPruneTuning(envWith());
    expect(tuning).toEqual({ retentionMs: DEFAULT_OUTBOX_RETENTION_MS });
  });

  it("coerces the retention var to a number", () => {
    const tuning = readPruneTuning(
      envWith({ OUTBOX_RETENTION_MS: "86400000" }),
    );
    expect(tuning).toEqual({ retentionMs: 86_400_000 });
  });

  it("rejects non-positive retention", () => {
    expect(() =>
      readPruneTuning(envWith({ OUTBOX_RETENTION_MS: "0" })),
    ).toThrow();
  });

  it("rejects non-numeric retention", () => {
    expect(() =>
      readPruneTuning(envWith({ OUTBOX_RETENTION_MS: "forever" })),
    ).toThrow();
  });
});
