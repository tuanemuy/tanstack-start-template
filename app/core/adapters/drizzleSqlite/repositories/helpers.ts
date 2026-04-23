import { SystemError, SystemErrorCode } from "@/core/application/error";
import { BusinessRuleError } from "@/core/domain/error";

/**
 * Run a rehydration callback (e.g. `Todo.fromPersistence`) and map any
 * `BusinessRuleError` it raises to a `SystemError(DatabaseError)`.
 *
 * The domain's factories enforce invariants; violating one during read-back
 * means the stored row is corrupt, which is an infrastructural failure, not
 * a business-rule failure the caller can recover from.
 */
export function rehydrate<T>(entityName: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof BusinessRuleError) {
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        `Stored ${entityName} violates invariants`,
        error,
      );
    }
    throw error;
  }
}

/**
 * Wrap a database operation so that any thrown value surfaces as a
 * `SystemError(DatabaseError)` with the given contextual message. Errors
 * that are already `SystemError` (e.g. re-thrown from {@link rehydrate}) or
 * a domain/application error we want to propagate pass through untouched.
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
