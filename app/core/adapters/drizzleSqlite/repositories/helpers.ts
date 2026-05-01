import { SystemError, SystemErrorCode } from "@/core/application/errors";

/**
 * Wrap a database call so any thrown value surfaces as a
 * `SystemError(DatabaseError)`. Errors already typed as `SystemError`
 * (e.g. from a row-to-entity conversion on a corrupt row) pass through
 * untouched. `ConflictError` from optimistic-lock predicates is thrown
 * outside this helper and is therefore not reached by the catch.
 */
export async function mapDbError<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SystemError) throw error;
    throw new SystemError(SystemErrorCode.DatabaseError, message, error);
  }
}
