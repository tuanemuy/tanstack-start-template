import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTodo } from "@repo/core/application/todo/createTodo";
import { listTodos } from "@repo/core/application/todo/listTodos";
import { isSerializableError } from "@repo/core/lib/error";
import { z } from "zod";
import { createMcpContainer } from "./container";

/**
 * Reference MCP server over the core usecases (stdio transport).
 * Transport-boundary rules match the web presentation layer: tool
 * inputs are validated by the SDK against the zod shapes below, thrown
 * errors surface through their `kind`-tagged serialized form as
 * `isError` results, and the usecase is trusted in between.
 *
 * Run: pnpm --filter @repo/mcp start
 * (register the same command as a stdio MCP server in your client)
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const body = isSerializableError(error)
    ? error.toSerialized()
    : { kind: "UnexpectedError", message: String(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

async function main(): Promise<void> {
  const container = await createMcpContainer();

  const server = new McpServer({
    name: "tanstack-start-template",
    version: "0.0.0",
  });

  server.registerTool(
    "todo_list",
    {
      description: "List todos (paginated). Returns todos and total count.",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ page, limit }) => {
      try {
        return ok(await listTodos({ container, input: { page, limit } }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "todo_create",
    {
      description: "Create a todo with the given title.",
      inputSchema: {
        title: z.string().min(1),
      },
    },
    async ({ title }) => {
      try {
        return ok(await createTodo({ container, input: { title } }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
