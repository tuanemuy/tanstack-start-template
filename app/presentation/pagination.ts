import type { Pagination } from "@repo/core/domain/common/pagination";
import { z } from "zod";

export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_MAX_PAGE = 10_000;
export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 20;

// Field-level base validators are the single source of truth for the
// transport-boundary domain-of-input (int, min, max). Both the strict
// RPC schema and the URL search schema derive from these, so the
// ceilings cannot drift between routes and server functions.
const pageField = z.number().int().min(1).max(PAGINATION_MAX_PAGE);
const limitField = z.number().int().min(1).max(PAGINATION_MAX_LIMIT);

// Strict numeric schema for server-function `inputValidator`. RPC payloads
// arrive already typed (JSON), so no coercion is needed; bad payloads must
// fail loud rather than silently fall back to defaults.
export const paginationSchema = z.object({
  page: pageField,
  limit: limitField,
});

// URL search variant for `validateSearch`. `z.coerce` adapts the stringly-
// typed URL inputs; `.pipe(field)` reuses the exact same constraints; and
// `.catch(default)` ensures a hand-typed `?page=abc` never errors the route.
export const paginationSearchSchema = z.object({
  page: z.coerce.number().pipe(pageField).catch(PAGINATION_DEFAULT_PAGE),
  limit: z.coerce.number().pipe(limitField).catch(PAGINATION_DEFAULT_LIMIT),
});

// Structural compatibility check: if either schema's output drifts from
// the domain `Pagination` contract, this fails at typecheck time.
type _PaginationSchemaMatches =
  z.infer<typeof paginationSchema> extends Pagination ? true : never;
type _PaginationSearchSchemaMatches =
  z.infer<typeof paginationSearchSchema> extends Pagination ? true : never;
const _paginationSchemaMatches: _PaginationSchemaMatches = true;
const _paginationSearchSchemaMatches: _PaginationSearchSchemaMatches = true;
void _paginationSchemaMatches;
void _paginationSearchSchemaMatches;
