declare const expectedVersionBrand: unique symbol;

/**
 * Token capturing the persisted version observed at read time.
 *
 * Adapters mint these inside `findById` (the only legitimate
 * construction site, via an internal `as` cast). The phantom `T`
 * parameter makes tokens nominal per aggregate — a token captured for
 * `Todo` cannot be passed to a `User` repository and vice versa, so
 * the brand catches both "forge a number" and "mix tokens across
 * aggregates" at the type level.
 */
export type ExpectedVersion<T> = number & {
  readonly [expectedVersionBrand]: T;
};

/**
 * Pair of an aggregate and the version token captured when it was
 * read. `findById` returns this so the caller can carry the
 * token into the matching `save` / `delete` call.
 */
export type Versioned<T> = {
  readonly entity: T;
  readonly expectedVersion: ExpectedVersion<T>;
};

/**
 * OCC-aware repository contract for an aggregate root.
 *
 * The contract enforces "read with intent to write goes through
 * `findById`" at the type level:
 *
 * - `insert` is the only path for first-time persistence; it does not
 *   require a token.
 * - `findById` returns the aggregate plus the captured token.
 *   Callers that intend to save / delete must obtain a token first.
 * - `save` / `delete` consume the token, so a usecase cannot
 *   accidentally re-derive the expected version from the in-memory
 *   aggregate (which has already been bumped by domain transitions).
 *
 * Both `save` and `delete` raise `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
 * when the supplied token does not match the persisted version.
 *
 * Read-only access patterns (listing, projection queries) live as
 * additional methods on the concrete repository interface — they are
 * intentionally not part of this base so that "must thread OCC" is
 * the only contract enforced here.
 *
 * `TId` should be bound to the aggregate's branded id value object
 * (e.g. `TransactionalRepository<Todo, TodoId>`), not left as the raw
 * `string` default. Binding it means the format invariant is validated
 * exactly once — at the usecase boundary via the id's smart
 * constructor, before the lookup — and a foreign id (a `UserId` passed
 * to a `Todo` repository) becomes a type error. The `string` default
 * exists only as a fallback for aggregates that have no dedicated id VO.
 */
export interface TransactionalRepository<TEntity, TId = string> {
  insert(entity: TEntity): Promise<void>;
  findById(id: TId): Promise<Versioned<TEntity> | null>;
  save(
    entity: TEntity,
    expectedVersion: ExpectedVersion<TEntity>,
  ): Promise<void>;
  delete(id: TId, expectedVersion: ExpectedVersion<TEntity>): Promise<void>;
}
