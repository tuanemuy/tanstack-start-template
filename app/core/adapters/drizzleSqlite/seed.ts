/**
 * Database seed script. Runs outside the server runtime (`pnpm db:seed` →
 * `tsx`), reusing `readServerConfig` + `createContainer` so it reads env
 * the same way the running server does.
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
