import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "./client";

type SqliteBatchItem = BatchItem<"sqlite">;

/**
 * Buffer that collects Drizzle query expressions to flush atomically via
 * `db.batch()` at the end of a unit of work.
 *
 * Two responsibilities:
 *
 * 1. **Aggregation.** Repository methods on D1 do not execute their
 *    writes immediately; they push a Drizzle query expression here
 *    and return so the caller keeps the `Promise<void>` repository
 *    contract regardless of whether the underlying engine supports
 *    interactive transactions. Reads still run immediately against
 *    the `Database`.
 *
 * 2. **OCC abort.** D1 batches treat an `UPDATE … WHERE version = ?`
 *    matching zero rows as a normal success and commit the rest. Each
 *    OCC-guarded write therefore registers a conflict handler and
 *    appends one extra statement to the batch:
 *
 *        INSERT INTO _occ_guard (n)
 *          SELECT changes() WHERE changes() = 0;
 *
 *    `changes()` reports the row count touched by the immediately
 *    preceding statement. When that is > 0 the SELECT yields no rows
 *    and the INSERT is a no-op; when it is 0 the SELECT yields a
 *    single row with `n = 0`, the `_occ_guard` CHECK (`n > 0`) fails,
 *    and the batch aborts. The UoW translates the resulting driver
 *    error into the registered handler — which is the only place a
 *    `ConflictError("OPTIMISTIC_LOCK_FAILURE")` can originate from
 *    inside D1's deferred-batch path. No follow-up DELETE is needed
 *    because the success path never inserts.
 *
 *    The guard intentionally fires on *both* a version mismatch and a
 *    missing row: in OCC semantics "the row I read is no longer
 *    valid" covers both cases, and the deferred-batch model has no
 *    cheaper way to distinguish them without a read-after-write.
 *
 * Why the guard handlers are FIFO-ordered: a batch can carry multiple
 * OCC writes (e.g. saving two aggregates in one usecase), but D1 stops
 * at the first failure. The guard at index `i` is the one that fired,
 * so handlers and writes share the same insertion order and the head
 * handler is the right one to throw on `flush()` failure.
 */
export class PendingBatch {
  private readonly items: SqliteBatchItem[] = [];
  private readonly conflictHandlers: Array<() => never> = [];

  constructor(private readonly db: Database) {}

  add(item: SqliteBatchItem): void {
    this.items.push(item);
  }

  /**
   * Append an OCC-guarded write. `onConflict` runs only if the batch
   * aborts due to this write's `_occ_guard` CHECK violation.
   */
  addOcc(write: SqliteBatchItem, onConflict: () => never): void {
    this.items.push(write);
    this.items.push(
      this.db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    );
    this.conflictHandlers.push(onConflict);
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Materialize the buffered statements as the tuple shape `db.batch`
   * requires. Caller must check `isEmpty()` first; D1 rejects empty
   * batches.
   */
  build(): [SqliteBatchItem, ...SqliteBatchItem[]] {
    if (this.items.length === 0) {
      throw new Error("PendingBatch.build called on an empty buffer");
    }
    return this.items as [SqliteBatchItem, ...SqliteBatchItem[]];
  }

  /**
   * The handler registered for the *first* OCC write in the batch.
   * Used by the UoW when it observes an `_occ_guard` violation: D1
   * stops at the first failing statement, so the head handler is the
   * one to surface.
   */
  firstConflictHandler(): (() => never) | undefined {
    return this.conflictHandlers[0];
  }
}
