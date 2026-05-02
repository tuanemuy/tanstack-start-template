import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
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
// server-only status setter directly. The `.server(...)` body is stripped
// from client bundles by the TanStack Start compiler, so importing
// `@tanstack/react-start/server` at module top-level is safe.
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
    if (status !== null) setResponseStatus(status);
    throw appError;
  }
});
