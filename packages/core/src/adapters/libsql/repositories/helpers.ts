import { LibsqlError } from "@libsql/client";
import {
  ApplicationError,
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { OCC_GUARD_CHECK_NAME } from "../schema";

// Drizzle wraps the driver error, so the LibsqlError can live anywhere
// in the `cause` chain.
function findLibsqlError(error: unknown): LibsqlError | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof LibsqlError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function findSqliteCode(error: unknown): string | null {
  const libsql = findLibsqlError(error);
  if (libsql === null) return null;
  // Prefer the extended code so downstream branches see the specific kind.
  if (libsql.extendedCode?.startsWith("SQLITE_")) return libsql.extendedCode;
  if (libsql.code?.startsWith("SQLITE_")) return libsql.code;
  return null;
}

/**
 * Detects the `_occ_guard` CHECK violation that signals an OCC failure.
 * Matches the constraint name so unrelated CHECKs fall through to a
 * generic `CONSTRAINT_VIOLATION`.
 */
export function isOccGuardViolation(error: unknown): boolean {
  const libsql = findLibsqlError(error);
  if (libsql === null) return false;
  const code = libsql.extendedCode ?? libsql.code ?? "";
  if (!code.startsWith("SQLITE_CONSTRAINT")) return false;
  return libsql.message.includes(OCC_GUARD_CHECK_NAME);
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
