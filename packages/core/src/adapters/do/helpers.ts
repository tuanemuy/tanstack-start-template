import {
  ApplicationError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";

/**
 * Failure boundary for calls into the todo-state DO. Anything thrown
 * DO-side arrives here as a plain deserialized `Error` — Workers RPC
 * does not preserve class identity — so there is nothing finer-grained
 * to translate: expected outcomes (OCC conflicts) already travel as
 * data in the RPC result types, and whatever still throws is a storage
 * or transport failure.
 */
export async function mapDoError<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new SystemError(SystemErrorCode.DatabaseError, message, error);
  }
}
