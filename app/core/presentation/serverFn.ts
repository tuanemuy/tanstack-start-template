import { createServerFn, type Method } from "@tanstack/react-start";
import { errorResponseMiddleware } from "./errorResponseMiddleware";

// Canonical entry point for server functions in this project. Pre-applies
// `errorResponseMiddleware` so callers can't forget to wrap. Use this instead
// of importing `createServerFn` directly.
export function defineServerFn<TMethod extends Method = "GET">(options?: {
  method?: TMethod;
}) {
  return createServerFn(options).middleware([errorResponseMiddleware]);
}
