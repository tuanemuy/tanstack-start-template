/**
 * Database seed script.
 *
 * Runs outside the server runtime (invoked via `pnpm db:seed` → `tsx`), so
 * it does not go through the server DI's `server-only` path. Instead we
 * reuse `createContainer` to build a container on-demand from a direct env
 * read.
 *
 * Each seed entry flows through the real `createTodo` usecase so that the
 * resulting rows (and their outbox events) look identical to what the
 * running application would produce.
 */

import "dotenv/config";

import { createContainer } from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";

type SeedTodo = { title: string };

const SEED_TODOS: readonly SeedTodo[] = [
  { title: "Buy groceries" },
  { title: "Read the TanStack Start docs" },
  { title: "Ship the todo template" },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.SQLITE_URL;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  if (!databaseUrl) {
    throw new Error("SQLITE_URL environment variable is not set");
  }

  const container = await createContainer({ databaseUrl, appUrl });

  for (const seed of SEED_TODOS) {
    const { todo } = await createTodo({
      container,
      input: { title: seed.title },
    });
    console.log(`seeded todo ${todo.id} — ${todo.title}`);
  }

  console.log(`seeded ${SEED_TODOS.length} todo(s)`);
}

void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error("seed failed:", error);
    process.exit(1);
  }
})();
