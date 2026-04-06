export class AnyError extends Error {
  override readonly name: string = "AnyError";
  override readonly cause?: AnyError | Error;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = isError(cause) ? cause : undefined;
  }
}

export function isError(error: unknown): error is AnyError | Error {
  return error instanceof Error || error instanceof AnyError;
}

export function fromUnknown(error: unknown): AnyError {
  // If already an AnyError, return as-is
  if (error instanceof AnyError) {
    return error;
  }

  if (error instanceof Error) {
    return new AnyError(error.message, error);
  }

  if (typeof error === "string") {
    return new AnyError(error);
  }

  return new AnyError("Unknown error occurred", error);
}
