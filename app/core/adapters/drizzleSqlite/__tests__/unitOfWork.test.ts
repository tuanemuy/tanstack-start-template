import { describe, expect, it } from "vitest";
import { isRetryableError } from "../unitOfWork";

/**
 * The Unit of Work retry loop reruns a transaction when SQLite reports
 * transient write-lock contention (`SQLITE_BUSY` / `SQLITE_LOCKED`). Any other
 * failure — including a nested-transaction attempt, which is a programming
 * bug — must surface immediately so the caller sees the real cause rather
 * than N more retries hiding it.
 */
describe("isRetryableError", () => {
  it("returns true for an error exposing a structured SQLITE_BUSY code", () => {
    const error = Object.assign(new Error("database busy"), {
      code: "SQLITE_BUSY",
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns true for an error exposing a structured SQLITE_LOCKED code", () => {
    const error = Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" });
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns true for a plain Error whose message says 'database is locked'", () => {
    const error = new Error("SQL step failed: database is locked");
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns true for a message mentioning 'database is busy'", () => {
    const error = new Error("database is busy, retry later");
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns false for a nested-transaction error (programming bug, not retryable)", () => {
    // This specific wording used to trigger a silent retry loop. The refactor
    // deliberately stops matching it so the underlying bug surfaces.
    const error = new Error("cannot start a transaction within a transaction");
    expect(isRetryableError(error)).toBe(false);
  });

  it("returns false for an arbitrary Error", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });

  it("returns false for a non-Error thrown value", () => {
    expect(isRetryableError("not an error")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError({ code: "SQLITE_BUSY" })).toBe(false);
  });
});
