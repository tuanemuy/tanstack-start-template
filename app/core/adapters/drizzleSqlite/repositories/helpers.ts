import { SystemError, SystemErrorCode } from "@/core/application/errors";

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
