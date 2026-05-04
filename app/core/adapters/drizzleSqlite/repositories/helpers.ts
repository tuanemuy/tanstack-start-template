import {
  ApplicationError,
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@/core/application/errors";

// Walks the `cause` chain because driver errors (e.g. LibsqlError) can be
// wrapped by drizzle or other layers before reaching here. The original
// SQLite code may live on `code` or `extendedCode` of any node in the chain.
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
    current = (current as { cause?: unknown }).cause;
  }
  return null;
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
