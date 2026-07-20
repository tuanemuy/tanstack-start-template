import { parseArgs } from "node:util";
import { createTodo } from "@repo/core/application/todo/createTodo";
import { listTodos } from "@repo/core/application/todo/listTodos";
import { isSerializableError } from "@repo/core/lib/error";
import { z } from "zod";
import { createCliContainer } from "./container";

/**
 * Reference CLI over the core usecases. Transport-boundary rules match
 * the web presentation layer: argv is validated here with zod, thrown
 * errors surface through their `kind`-tagged serialized form, and the
 * usecase is trusted in between.
 *
 * Usage:
 *   pnpm --filter @repo/cli start todo list [--page 1] [--limit 20]
 *   pnpm --filter @repo/cli start todo add --title "Buy milk"
 */

const listInputSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const addInputSchema = z.object({
  title: z.string().min(1, "--title is required"),
});

function usage(): never {
  console.error(
    [
      "usage:",
      "  todo list [--page <n>] [--limit <n>]",
      '  todo add --title "<title>"',
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string" },
      limit: { type: "string" },
      title: { type: "string" },
    },
  });

  const [resource, command] = positionals;
  if (resource !== "todo") usage();

  const container = await createCliContainer();

  switch (command) {
    case "list": {
      const input = listInputSchema.parse(values);
      const output = await listTodos({ container, input });
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    case "add": {
      const input = addInputSchema.parse(values);
      const output = await createTodo({ container, input });
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  if (isSerializableError(error)) {
    console.error(JSON.stringify(error.toSerialized(), null, 2));
  } else if (error instanceof z.ZodError) {
    console.error(
      JSON.stringify({ kind: "InvalidInput", issues: error.issues }, null, 2),
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
