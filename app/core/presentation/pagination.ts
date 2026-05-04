import { z } from "zod";

export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 20;

// Strict numeric schema for server-function `inputValidator`. RPC payloads
// arrive already typed (JSON), so no coercion is needed; bad payloads must
// fail loud rather than silently fall back to defaults.
export const paginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(PAGINATION_MAX_LIMIT),
});

// URL search variant for `validateSearch`. Coerces strings (URLs are
// stringly-typed) and falls back to defaults per-field so a hand-typed
// `?page=abc` never errors the route. Same `max` ceiling as the strict
// schema so route and RPC stay in lockstep through `PAGINATION_MAX_LIMIT`.
export const paginationSearchSchema = z.object({
  page: z.coerce.number().int().min(1).catch(PAGINATION_DEFAULT_PAGE),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION_MAX_LIMIT)
    .catch(PAGINATION_DEFAULT_LIMIT),
});
