import { isNotFound, isRedirect } from "@tanstack/react-router";
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  AppServerError,
  httpStatusFor,
  isAppServerError,
  serializeError,
} from "./errorResponse";

// Lives in a `.server.ts` file because `setResponseStatus` is server-only —
// importing it from a module reachable by the client bundle trips the RSC
// import-protection plugin.
export async function withErrorResponse<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (isNotFound(error)) throw error;
    if (isAppServerError(error)) throw error;
    const serialized = serializeError(error);
    const status = httpStatusFor(serialized);
    if (status !== null) setResponseStatus(status);
    throw new AppServerError(serialized);
  }
}
