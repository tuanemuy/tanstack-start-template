import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";

/**
 * RPC protocol between the request Worker and the todo-state Durable
 * Object.
 *
 * Everything crossing the boundary is plain structured-clonable data.
 * In particular, outcomes that the request side must react to —
 * OCC conflicts — travel as values inside `CommitResult`, never as
 * thrown error classes: Workers RPC serializes exceptions into plain
 * `Error`s, so class identity (and any `instanceof`-based handling)
 * does not survive the wire. The request-side adapters rebuild the
 * typed application errors from these values.
 */

/**
 * Single reference scope for the template's one global todo list. A
 * real multi-tenant app derives this from the authenticated principal
 * (`user:{id}`, `workspace:{id}`, …) so each tenant gets its own DO —
 * and with it structural isolation: there is no cross-tenant query to
 * forget a WHERE clause on.
 */
export const DEFAULT_TODO_SCOPE = "default";

/** At-rest shape of a todo aggregate as the DO stores and returns it. */
export type TodoStateRow = Readonly<{
  id: string;
  title: string;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

/**
 * Buffered writes of one unit of work, applied atomically by the DO
 * inside a single `transactionSync`. OCC predicates are evaluated
 * per-statement (`UPDATE … WHERE id = ? AND version = ? RETURNING 1`),
 * so a conflict is attributed to the exact command that failed — no
 * post-hoc guard-table inference as in the D1 adapter.
 */
export type TodoWriteCommand =
  | Readonly<{ kind: "insert"; row: TodoStateRow }>
  | Readonly<{ kind: "save"; row: TodoStateRow; expectedVersion: number }>
  | Readonly<{ kind: "delete"; id: string; expectedVersion: number }>;

/** Identity-attached domain event bound for the DO-local outbox. */
export type OutboxEventInput = Readonly<{
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId: string;
}>;

export type CommitRequest = Readonly<{
  writes: readonly TodoWriteCommand[];
  events: readonly OutboxEventInput[];
}>;

export type CommitResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{
      kind: "conflict";
      command: "save" | "delete";
      todoId: string;
      expectedVersion: number;
    }>;

/**
 * The DO's RPC surface as the request/consumer side consumes it. The
 * Durable Object class implements these as public RPC methods; callers
 * hold the stub behind this structural interface so nothing outside
 * the entry-point wiring depends on platform stub types.
 */
export interface TodoStateClient {
  findTodoById(id: string): Promise<TodoStateRow | null>;
  findTodoPage(pagination: Pagination): Promise<PaginationResult<TodoStateRow>>;
  commit(request: CommitRequest): Promise<CommitResult>;
  markEventProcessed(id: string): Promise<{ alreadyProcessed: boolean }>;
  /** Re-arm the outbox alarm — operator escape hatch after manual row edits. */
  kickRelay(): Promise<void>;
}
