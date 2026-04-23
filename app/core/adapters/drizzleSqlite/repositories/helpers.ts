import { SystemError, SystemErrorCode } from "@/core/application/error";

/**
 * Wrap a database operation so that any thrown value surfaces as a
 * `SystemError(DatabaseError)` with the given contextual message. Errors
 * that are already `SystemError` (e.g. thrown by a repository's own
 * row-to-entity conversion on a corrupt row) pass through untouched so the
 * original context is preserved. Application-level errors that callers need
 * to see (e.g. `ConflictError` from an optimistic-lock failure) are thrown
 * outside this helper, so they are not reached by the `catch` here.
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
