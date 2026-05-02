import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import {
  AppServerError,
  httpStatusFor,
  isAppServerError,
  serializeError,
} from "./errorResponse";

// Wraps the entire server-function pipeline so throws from `inputValidator`
// and the handler land in the same catch. Setting the response status from
// inside the handler alone would miss validator throws (they fire before
// `.handler` runs), and the constructor of `AppServerError` can't touch the
// server-only status setter directly.
//
// `setResponseStatus` is loaded via dynamic import so this module stays safe
// to pull into the client graph (route files import it transitively via
// `defineServerFn`). The body only runs server-side because of `.server(...)`.
export const errorResponseMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    const appError = isAppServerError(error)
      ? error
      : new AppServerError(serializeError(error));
    const status = httpStatusFor(appError.serialized);
    if (status !== null) {
      const { setResponseStatus } = await import(
        "@tanstack/react-start/server"
      );
      setResponseStatus(status);
    }
    throw appError;
  }
});
