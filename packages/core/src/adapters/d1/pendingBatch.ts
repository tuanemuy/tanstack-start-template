import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "./client";

type SqliteBatchItem = BatchItem<"sqlite">;

/**
 * Re-evaluates an OCC write's predicate against the current database.
 * Returns `true` while the predicate still matches a row (the write
 * would succeed if re-run), `false` once it matches nothing.
 */
export type OccProbe = () => Promise<boolean>;

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
 * Attribution across multiple OCC writes: a batch can carry several
 * (e.g. saving two aggregates in one usecase), D1 stops at the first
 * failing guard, and the driver error does not say which statement
 * fired. The batch has rolled back by then, so the culprit is
 * re-derived by re-evaluating each OCC predicate (`probe`) in
 * insertion order against the restored database: writes ahead of the
 * culprit matched a row at execution time and still do after rollback,
 * while the culprit matched zero rows and still does. The first probe
 * reporting "no match" identifies the guard that fired.
 *
 * Two caveats, both strictly no worse than naive head-handler
 * attribution: a concurrent writer mutating rows between the abort and
 * the probes can shift attribution (the blamed row would still
 * conflict on retry, so the error stays truthful), and two OCC writes
 * targeting the same row in one batch can self-invalidate in a way the
 * probes cannot see (repositories persist each aggregate once per UoW,
 * so this shape does not occur). If every probe still matches or a
 * probe read fails, attribution falls back to the head handler.
 */
export class PendingBatch {
  private readonly items: SqliteBatchItem[] = [];
  private readonly occWrites: Array<{
    readonly probe: OccProbe;
    readonly onConflict: () => never;
  }> = [];

  constructor(private readonly db: Database) {}

  add(item: SqliteBatchItem): void {
    this.items.push(item);
  }

  /**
   * Append an OCC-guarded write. `onConflict` runs only if the batch
   * aborts due to this write's `_occ_guard` CHECK violation. `probe`
   * must re-evaluate the write's OCC predicate (typically
   * `id = ? AND version = ?`) and report whether it still matches a
   * row — it runs only on the post-abort attribution path.
   */
  addOcc(
    write: SqliteBatchItem,
    onConflict: () => never,
    probe: OccProbe,
  ): void {
    this.items.push(write);
    this.items.push(
      this.db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    );
    this.occWrites.push({ probe, onConflict });
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
   * The handler for the OCC write whose guard aborted the batch,
   * identified by probing each write's predicate in insertion order
   * (see the class doc). Falls back to the head handler when probing
   * is inconclusive; `undefined` only when no OCC write was buffered.
   */
  async resolveConflictHandler(): Promise<(() => never) | undefined> {
    for (const { probe, onConflict } of this.occWrites) {
      let matches: boolean;
      try {
        matches = await probe();
      } catch {
        break;
      }
      if (!matches) return onConflict;
    }
    return this.occWrites[0]?.onConflict;
  }
}
