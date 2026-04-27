/**
 * Request shape for paginated reads.
 *
 * `page` is 1-indexed. Adapters translate to `(page - 1) * limit` when
 * computing `OFFSET`.
 */
export type Pagination = Readonly<{
  page: number;
  limit: number;
}>;

/**
 * Response shape for paginated reads. `items` holds the current page and
 * `count` holds the total matching row count (not just the page size) so
 * callers can compute page counts without a second query.
 */
export type PaginationResult<T> = Readonly<{
  items: readonly T[];
  count: number;
}>;
