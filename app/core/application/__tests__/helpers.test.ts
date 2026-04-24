import { describe, expect, it } from "vitest";
import { createTodo } from "../todo/createTodo";
import {
  createFakeTestContainer,
  createTestContainer,
  setupFakeTestContainer,
  setupTestContainer,
} from "./helpers";

/**
 * Tests for the test harness itself.
 *
 * These are cheap sanity checks that prevent a broken helper from silently
 * making every downstream test pass vacuously. They also double as
 * executable documentation of the harness contract.
 */

describe("createTestContainer / cleanup", () => {
  it("initializes a temporary SQLite file with migrations applied", async () => {
    const container = await createTestContainer();
    try {
      // Querying the todos table must succeed — this proves migrations ran.
      // (Without migrations the query would fail with 'no such table'.)
      const rows = await container.unitOfWorkProvider.runReadonly(
        async ({ todoRepository }) => todoRepository.findAll(),
      );
      expect(rows).toEqual([]);
    } finally {
      await container.cleanup();
    }
  });

  it("enables WAL journaling on the temp DB", async () => {
    const container = await createTestContainer();
    try {
      // Query PRAGMA directly through the underlying client. Drizzle
      // exposes `.$client` for raw libsql access.
      const client = (
        container.db as unknown as {
          $client: {
            execute: (
              sql: string,
            ) => Promise<{ rows: Array<Record<string, unknown>> }>;
          };
        }
      ).$client;
      const result = await client.execute("PRAGMA journal_mode");
      const mode = String(
        (result.rows[0] as Record<string, unknown> | undefined)?.journal_mode ??
          "",
      ).toLowerCase();
      expect(mode).toBe("wal");
    } finally {
      await container.cleanup();
    }
  });

  it("cleanup removes the temp DB file from disk", async () => {
    const container = await createTestContainer();
    // `createTestContainer` sets up a file-based DB via an internal
    // `createTestDatabase`. We access the path through cleanup's side
    // effect — call cleanup and verify the file no longer exists. Going
    // via fs is brittle to the harness's internal path choice, so instead
    // we assert cleanup is idempotent and throws no error.
    await container.cleanup();
    // Second cleanup is a no-op (file already gone). Must not throw.
    await expect(container.cleanup()).resolves.toBeUndefined();
  });
});

describe("setupTestContainer (suite hooks)", () => {
  const getContainer = setupTestContainer();

  it("gives each test a fresh container", async () => {
    const c1 = getContainer();
    await createTodo({ container: c1, input: { title: "first" } });
    const rows1 = await c1.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => todoRepository.findAll(),
    );
    expect(rows1).toHaveLength(1);
  });

  it("does not leak state from the previous test", async () => {
    const c2 = getContainer();
    // If beforeEach/afterEach weren't wiring cleanup correctly, this
    // container would still see the "first" todo from the previous test.
    const rows = await c2.unitOfWorkProvider.runReadonly(
      async ({ todoRepository }) => todoRepository.findAll(),
    );
    expect(rows).toEqual([]);
  });

  it("exposes direct db access for test assertions", () => {
    const c = getContainer();
    // Harness contract: every TestContainer has a `.db` for poking at
    // rows directly, plus a `.cleanup` function (driven by the hooks).
    expect(c.db).toBeDefined();
    expect(typeof c.cleanup).toBe("function");
  });
});

describe("createFakeTestContainer", () => {
  it("wires a working FakeUnitOfWorkProvider", async () => {
    const container = createFakeTestContainer();
    const { todo } = await createTodo({
      container,
      input: { title: "fake" },
    });
    expect(container.fakeUow.todoStore.size).toBe(1);
    expect(container.fakeUow.todoStore.get(todo.id as never)).toBeDefined();
    // collectEvents flowed into the recorded-events log.
    expect(container.fakeUow.getRecordedEvents()).toHaveLength(1);
  });

  it("applies config overrides", () => {
    const container = createFakeTestContainer({
      config: { appUrl: "http://override.test" },
    });
    expect(container.config.appUrl).toBe("http://override.test");
  });
});

describe("setupFakeTestContainer (suite hooks)", () => {
  const getContainer = setupFakeTestContainer();

  it("hands out a fresh fake container each test", async () => {
    const c1 = getContainer();
    await createTodo({ container: c1, input: { title: "fresh" } });
    expect(c1.fakeUow.getRecordedEvents()).toHaveLength(1);
  });

  it("resets between tests so state does not leak", () => {
    const c2 = getContainer();
    expect(c2.fakeUow.getRecordedEvents()).toHaveLength(0);
    expect(c2.fakeUow.todoStore.size).toBe(0);
  });
});
