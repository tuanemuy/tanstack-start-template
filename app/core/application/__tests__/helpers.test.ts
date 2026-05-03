import { describe, expect, it } from "vitest";
import * as schema from "@/core/adapters/drizzleSqlite/schema";
import { createTodo } from "../todo/createTodo";
import { createTestContainer, setupTestContainer } from "./helpers";

/**
 * Tests for the test harness itself.
 *
 * These are cheap sanity checks that prevent a broken helper from silently
 * making every downstream test pass vacuously. They also double as
 * executable documentation of the harness contract.
 */

describe("createTestContainer / shutdown", () => {
  it("initializes an in-memory SQLite with migrations applied", async () => {
    const container = await createTestContainer();
    try {
      // Querying the todos table must succeed — this proves migrations ran.
      // (Without migrations the query would fail with 'no such table'.)
      const rows = await container.db.select().from(schema.todos);
      expect(rows).toEqual([]);
    } finally {
      await container.shutdown();
    }
  });

  it("shutdown is safe to call multiple times", async () => {
    const container = await createTestContainer();
    await container.shutdown();
    // Second shutdown must not throw — the harness contract.
    await expect(container.shutdown()).resolves.toBeUndefined();
  });
});

describe("setupTestContainer (suite hooks)", () => {
  const getContainer = setupTestContainer();

  it("gives each test a fresh container", async () => {
    const c1 = getContainer();
    await createTodo({ container: c1, input: { title: "first" } });
    const rows1 = await c1.db.select().from(schema.todos);
    expect(rows1).toHaveLength(1);
  });

  it("does not leak state from the previous test", async () => {
    const c2 = getContainer();
    // If beforeEach/afterEach weren't wiring cleanup correctly, this
    // container would still see the "first" todo from the previous test.
    const rows = await c2.db.select().from(schema.todos);
    expect(rows).toEqual([]);
  });

  it("exposes direct db access for test assertions", () => {
    const c = getContainer();
    // Harness contract: every TestContainer has a `.db` for poking at
    // rows directly, plus a `.shutdown` function (driven by the hooks).
    expect(c.db).toBeDefined();
    expect(typeof c.shutdown).toBe("function");
  });
});
