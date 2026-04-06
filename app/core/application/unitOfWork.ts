// import type { OutboxRepository } from "@/core/domain/outbox/ports/outboxRepository";
// import type { ${Entity}Repository } from "@/core/domain/${entity}/ports/${entity}Repository";

export type Repositories = {
  // outboxRepository: OutboxRepository;
  // ${entity}Repository: ${Entity}Repository;
};

/**
 * Repositories with event collector for transaction context
 */
export type TransactionContext = Repositories;

export interface UnitOfWorkProvider {
  /**
   * Execute a transaction with automatic event collection and persistence.
   * Events added to the eventCollector are automatically saved to the Outbox
   * as part of the transaction.
   */
  transaction<T>(fn: (context: TransactionContext) => Promise<T>): Promise<T>;
}
