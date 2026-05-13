import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { getContainer } from "@/core/application/di/server";
import {
  AppServerError,
  httpStatusFor,
  redactForClient,
  type SerializedError,
  serializeError,
} from "./errorResponse";

// Wraps the entire server-function pipeline so throws from `inputValidator`
// and the handler land in the same catch. Setting the response status from
// inside the handler alone would miss validator throws (they fire before
// `.handler` runs), and the constructor of `AppServerError` can't touch the
// server-only status setter directly. The `.server(...)` body is stripped
// from client bundles by the TanStack Start compiler, so importing
// `@tanstack/react-start/server` at module top-level is safe.
//
// This is the single redaction boundary for outbound errors: the raw
// serialized form is handed to the injected `Logger` for ops triage, and
// the client receives only `redactForClient(...)`. Logger output policy
// (console, structured JSON, sink, …) is owned by the implementation that
// the container injects — the middleware just forwards the raw payload.
export const errorResponseMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;

    const rawSerialized =
      error instanceof AppServerError
        ? error.serialized
        : serializeError(error);

    if (rawSerialized.kind === "system" || rawSerialized.kind === "unknown") {
      await logServerError(error, rawSerialized);
    }

    const clientSerialized = redactForClient(rawSerialized);
    const appError = new AppServerError(clientSerialized);
    setResponseStatus(httpStatusFor(clientSerialized));
    throw appError;
  }
});

// `getContainer` is statically imported at module top: `di/server.ts` is
// designed to be client-graph safe (node-only imports live in
// `app/server.ts` behind `containerStore`), so traversal during the
// client build does not pull `node:async_hooks` into client chunks.
// The fallback `console.error` only fires if container resolution or
// logger dispatch itself throws — without it a wiring bug would
// silently swallow the original error.
async function logServerError(
  error: unknown,
  serialized: SerializedError,
): Promise<void> {
  try {
    const { logger } = await getContainer();
    logger.error("Server function failed", {
      kind: serialized.kind,
      code: serialized.code,
      message: serialized.message,
      cause: error,
    });
  } catch (logError) {
    console.error("Server function failed (logger unavailable)", {
      original: error,
      logError,
    });
  }
}
