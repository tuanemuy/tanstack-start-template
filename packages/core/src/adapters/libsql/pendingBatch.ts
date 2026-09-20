import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "./client";

export type SqliteBatchItem = BatchItem<"sqlite">;

/**
 * Buffer of pending writes flushed atomically through one `db.batch()`.
 * SQLite treats `UPDATE ... WHERE version = ?` matching zero rows as
 * success, so each OCC write appends an extra `_occ_guard` insert that
 * fails the CHECK when `changes() = 0`, aborting the batch. The driver
 * reports the index of the failing statement, which identifies the guard
 * — and therefore the conflict handler — exactly.
 */
export class PendingBatch {
  private readonly items: SqliteBatchItem[] = [];
  private readonly conflictHandlers = new Map<number, () => never>();

  constructor(private readonly db: Database) {}

  add(item: SqliteBatchItem): void {
    this.items.push(item);
  }

  /** Append an OCC-guarded write. `onConflict` fires iff this write matched zero rows. */
  addOcc(write: SqliteBatchItem, onConflict: () => never): void {
    this.items.push(write);
    this.conflictHandlers.set(this.items.length, onConflict);
    this.items.push(
      this.db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    );
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Buffered statements in insertion order. Check `isEmpty()` first. */
  build(): [SqliteBatchItem, ...SqliteBatchItem[]] {
    if (this.items.length === 0) {
      throw new Error("PendingBatch.build called on an empty buffer");
    }
    return this.items as [SqliteBatchItem, ...SqliteBatchItem[]];
  }

  /** Handler of the OCC write whose guard sits at `statementIndex`. */
  conflictHandlerAt(statementIndex: number): (() => never) | undefined {
    return this.conflictHandlers.get(statementIndex);
  }
}
