import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Common surface of the libSQL Drizzle handle and a `LibSQLTransaction`,
 * so repositories type their executor against either at flush time.
 */
export type TxExecutor = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "run"
>;

/**
 * Buffered statement. `occ` carries the conflict handler that fires
 * when the following `occ-guard` CHECK aborts the transaction.
 */
export type PendingStatement =
  | {
      readonly kind: "write";
      readonly run: (executor: TxExecutor) => Promise<unknown>;
    }
  | {
      readonly kind: "occ";
      readonly run: (executor: TxExecutor) => Promise<unknown>;
      readonly onConflict: () => never;
    }
  | {
      readonly kind: "occ-guard";
      readonly run: (executor: TxExecutor) => Promise<unknown>;
    };

/**
 * Buffer of pending writes flushed atomically inside one libSQL
 * interactive transaction. SQLite treats `UPDATE ... WHERE version = ?`
 * matching zero rows as success, so each OCC write appends an extra
 * `_occ_guard` insert that fails the CHECK when `changes() = 0`,
 * aborting the transaction and surfacing the registered conflict handler.
 */
export class PendingBatch {
  private readonly statements: PendingStatement[] = [];

  add(write: (executor: TxExecutor) => Promise<unknown>): void {
    this.statements.push({ kind: "write", run: write });
  }

  /** Append an OCC-guarded write. `onConflict` fires iff this write matched zero rows. */
  addOcc(
    write: (executor: TxExecutor) => Promise<unknown>,
    onConflict: () => never,
  ): void {
    this.statements.push({ kind: "occ", run: write, onConflict });
    this.statements.push({
      kind: "occ-guard",
      run: (executor) =>
        executor.run(
          sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
        ),
    });
  }

  isEmpty(): boolean {
    return this.statements.length === 0;
  }

  /** Buffered statements in insertion order. Check `isEmpty()` first. */
  build(): readonly PendingStatement[] {
    return this.statements;
  }
}
