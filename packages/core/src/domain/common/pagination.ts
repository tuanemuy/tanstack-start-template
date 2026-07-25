/** Request shape for paginated reads. `page` is 1-indexed. */
export type Pagination = Readonly<{
  page: number;
  limit: number;
}>;

/** `count` is the total matching rows, not just the current page size. */
export type PaginationResult<T> = Readonly<{
  items: readonly T[];
  count: number;
}>;
