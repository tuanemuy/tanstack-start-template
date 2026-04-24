import { z } from "zod";

/**
 * Server-function input schemas, owned by the presentation layer and
 * intentionally independent of the domain.
 *
 * `actions.ts` is reachable from the client bundle (TanStack Start runs
 * `inputValidator` on both ends of a server function), so any module it
 * touches statically ships to the browser. Importing the domain's Zod
 * schema would drag `TodoTitle.create`, `BusinessRuleError`, the UUIDv7
 * generator, and every transitive domain dependency into the client
 * graph — both a Clean-Architecture inversion (presentation → domain)
 * and a bundle-bloat regression.
 *
 * These schemas exist to (a) keep transport-level rejection close to the
 * user (no round-trip for an obviously empty title) and (b) emit Zod
 * issues with field paths so the same `fieldErrors` UI path covers both
 * transport-level and usecase-level failures. The domain factories
 * (`TodoTitle.create`, `TodoId.create`) remain the authoritative final
 * gate — if these constraints ever drift looser than the domain, the
 * domain wins at runtime by throwing `BusinessRuleError`.
 *
 * Kept aligned with the domain by convention. Tighten/loosen here for
 * transport reasons (DoS guard, UX) without touching domain code.
 */

export const TODO_TITLE_MAX_LENGTH = 140;

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export const changeTodoStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "completed"]),
});

export const deleteTodoSchema = z.object({
  id: z.string().min(1),
});
