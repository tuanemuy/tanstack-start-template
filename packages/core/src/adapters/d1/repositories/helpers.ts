import {
  ApplicationError,
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { OCC_GUARD_CHECK_NAME } from "../schema";

// Walks the `cause` chain because driver errors (D1's `Error_` from
// `@cloudflare/workers-types`) are wrapped by Drizzle before reaching the
// adapter boundary. The original SQLite code can live on `code`,
// `extendedCode`, or be embedded in the message text on D1.
function findSqliteCode(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const extended = (current as { extendedCode?: unknown }).extendedCode;
    if (typeof extended === "string" && extended.startsWith("SQLITE_")) {
      return extended;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_")) {
      return code;
    }
    // D1 surfaces some constraint failures only via the message text,
    // e.g. "D1_ERROR: UNIQUE constraint failed: todos.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)".
    // Both the generic and extended form appear in one string, so pick
    // the longest (most specific) match — otherwise PK / UNIQUE / FK
    // collisions get silently flattened into a generic CONSTRAINT_VIOLATION.
    if (typeof current.message === "string") {
      const matches = current.message.match(/SQLITE_\w+/g);
      if (matches && matches.length > 0) {
        return matches.reduce((longest, candidate) =>
          candidate.length > longest.length ? candidate : longest,
        );
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

// `_occ_guard` is the deferred-batch UoW's abort lever for OCC failures.
// Detection is by message substring because D1 surfaces CHECK violations
// only as a generic `D1_ERROR: CHECK constraint failed: <name>` string —
// no `extendedCode` reaches the adapter boundary. The guard's CHECK name
// is shared with `d1/schema.ts` via `OCC_GUARD_CHECK_NAME`; an unrelated
// CHECK on another table will not match here and will surface as a
// `CONSTRAINT_VIOLATION` like any other adapter.
//
// If D1 drops the CHECK name from the message, the OCC handler is
// skipped and the error degrades to ConflictError("CONSTRAINT_VIOLATION")
// via mapDbError — `helpers.integration.test.ts` is the canary.
export function isOccGuardViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      typeof current.message === "string" &&
      current.message.includes(OCC_GUARD_CHECK_NAME)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function constraintViolationCode(sqliteCode: string): string {
  if (
    sqliteCode === "SQLITE_CONSTRAINT_UNIQUE" ||
    sqliteCode === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return "UNIQUE_VIOLATION";
  }
  if (sqliteCode === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    return "FOREIGN_KEY_VIOLATION";
  }
  return "CONSTRAINT_VIOLATION";
}

export async function mapDbError<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const sqliteCode = findSqliteCode(error);
    if (sqliteCode?.startsWith("SQLITE_CONSTRAINT")) {
      throw new ConflictError(
        constraintViolationCode(sqliteCode),
        message,
        error,
      );
    }
    throw new SystemError(SystemErrorCode.DatabaseError, message, error);
  }
}
