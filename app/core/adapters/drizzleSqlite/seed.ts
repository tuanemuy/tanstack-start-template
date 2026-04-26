/**
 * Database seed script.
 *
 * Runs outside the server runtime (invoked via `pnpm db:seed` → `tsx`), so
 * it does not go through the server DI's `server-only` path. Instead we
 * reuse `readServerConfig` + `createContainer` so this script reads env the
 * same way the running server does — no parallel "fallback to localhost"
 * defaults that could drift from production behaviour.
 *
 * Each seed entry flows through the real `createTodo` usecase so that the
 * resulting rows (and their outbox events) look identical to what the
 * running application would produce.
 */

import "dotenv/config";

import {
  createContainer,
  readServerConfig,
} from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";

type SeedTodo = { title: string };

const SEED_TODOS: readonly SeedTodo[] = [
  { title: "Buy groceries" },
  { title: "Read the TanStack Start docs" },
  { title: "Ship the todo template" },
];

async function main(): Promise<void> {
  // Single env-read implementation. If `APP_URL` / `SQLITE_URL` are missing,
  // `readServerConfig` throws the same error users see on server startup.
  const config = readServerConfig();
  const container = await createContainer(config);

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
