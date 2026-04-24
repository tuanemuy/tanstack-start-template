import { describe, expect, it } from "vitest";
import { retry } from "../execution/retry";

describe("retry", () => {
  it("returns the resolved value when the callback eventually succeeds", async () => {
    let calls = 0;

    const value = await retry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("retryable");
        }
        return "ok";
      },
      {
        maxAttempts: 2,
        shouldRetry: (error) =>
          error instanceof Error && error.message === "retryable",
      },
    );

    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns the value on the first call when no retry is needed", async () => {
    let calls = 0;

    const value = await retry(
      async () => {
        calls += 1;
        return 42;
      },
      {
        maxAttempts: 3,
        shouldRetry: () => true,
      },
    );

    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it("re-throws immediately when shouldRetry rejects the error on the first attempt", async () => {
    let calls = 0;
    const error = new Error("fatal");

    await expect(
      retry(
        async () => {
          calls += 1;
          throw error;
        },
        {
          maxAttempts: 2,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toBe(error);

    // shouldRetry rejected the error, so the loop short-circuited rather
    // than running out of budget — only the initial attempt ran.
    expect(calls).toBe(1);
  });

  it("re-throws the last error after maxAttempts retryable errors", async () => {
    let calls = 0;
    const error = new Error("retryable");

    await expect(
      retry(
        async () => {
          calls += 1;
          throw error;
        },
        {
          maxAttempts: 3,
          shouldRetry: () => true,
        },
      ),
    ).rejects.toBe(error);

    expect(calls).toBe(3);
  });

  it("invokes onRetry between attempts with the failed-attempt index and the thrown error", async () => {
    let calls = 0;
    const error = new Error("retryable");
    const observed: Array<{ attempt: number; error: unknown }> = [];

    await expect(
      retry(
        async () => {
          calls += 1;
          throw error;
        },
        {
          maxAttempts: 3,
          shouldRetry: () => true,
          onRetry: (attempt, err) => {
            observed.push({ attempt, error: err });
          },
        },
      ),
    ).rejects.toBe(error);

    expect(calls).toBe(3);
    // onRetry fires only between attempts (after attempt 1 and attempt 2),
    // never after the final attempt that exhausts the budget.
    expect(observed).toEqual([
      { attempt: 1, error },
      { attempt: 2, error },
    ]);
  });

  it("rejects a non-positive maxAttempts up front", async () => {
    await expect(
      retry(async () => "unused", {
        maxAttempts: 0,
        shouldRetry: () => true,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
