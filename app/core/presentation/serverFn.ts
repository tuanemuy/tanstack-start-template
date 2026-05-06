import { createServerFn, type Method } from "@tanstack/react-start";
import { errorResponseMiddleware } from "./errorResponseMiddleware";

// Canonical entry point for server functions in this project. Pre-applies
// `errorResponseMiddleware` so callers can't forget to wrap. Use this instead
// of importing `createServerFn` directly.
//
// Defaults to POST because this template's primary server-fn use case is
// usecase-backed mutation. For idempotent reads (loader bridges, RSC render
// proxies), use `defineQueryFn` so the GET semantics are explicit at the call
// site rather than relying on a default.
export function defineServerFn<TMethod extends Method = "POST">(options?: {
  method?: TMethod;
}) {
  return createServerFn(options).middleware([errorResponseMiddleware]);
}

export function defineQueryFn() {
  return defineServerFn({ method: "GET" });
}
