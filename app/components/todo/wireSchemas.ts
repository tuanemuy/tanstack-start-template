import { z } from "zod";

/**
 * Wire-format validation, intentionally independent of the domain.
 *
 * `actions.ts` is reachable from the client bundle (TanStack Start runs
 * `inputValidator` on both ends of a server function), so any module it
 * touches statically is shipped to the browser. Reusing the domain's Zod
 * schema would drag `TodoTitle.create`, `BusinessRuleError`, the UUIDv7
 * generator, and every transitive domain import into the client graph —
 * a Clean-Architecture inversion *and* a bundle-bloat regression.
 *
 * These wire schemas exist to (a) keep transport-level rejection close to
 * the user (no round-trip for an obviously empty title) and (b) emit Zod
 * issues with field paths so the same `fieldErrors` UI path works for
 * both wire-level and usecase-level failures. The domain factories
 * (`TodoTitle.create`, `TodoId.create`) remain the authoritative final
 * gate; if these wire constraints ever drift looser than the domain, the
 * domain wins at runtime by throwing `BusinessRuleError`.
 *
 * Kept aligned with the domain by convention. Tighten/loosen wire rules
 * for transport reasons (DoS guard, UX) without touching domain code.
 */

export const TODO_TITLE_WIRE_MAX_LENGTH = 140;

export const createTodoWireSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_WIRE_MAX_LENGTH),
});

export const changeTodoStatusWireSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "completed"]),
});

export const deleteTodoWireSchema = z.object({
  id: z.string().min(1),
});
