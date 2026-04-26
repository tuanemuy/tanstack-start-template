import { z } from "zod";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";

const TODO_TITLE_MAX_LENGTH = 140;

// UUIDv7 pattern: standard UUID with version nibble `7` and RFC4122 variant
// nibble in {8,9,a,b}.
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Private nominal brand markers.
 *
 * `unique symbol` + `declare const` gives each brand a nominal identity that
 * cannot be reproduced by normal structural assignment from another module.
 * This makes the factory in this file the only legitimate construction path.
 *
 * TypeScript assertions (`value as TodoId`) can still bypass the checker, so
 * boundaries that read untrusted data must always re-run the factory.
 */
declare const todoIdBrand: unique symbol;
declare const todoTitleBrand: unique symbol;

/**
 * Branded identifier for the `Todo` aggregate.
 *
 * Intentionally strict: we only accept UUIDv7 strings. Aggregate ids are
 * server-minted (via the application layer's `IdGenerator` port — never from
 * client input), so any non-UUIDv7 value reaching `TodoId.create` indicates
 * corrupt storage or a programming error. Rejecting up front prevents
 * malformed ids from leaking through the system.
 *
 * ## Why no `generate` here
 *
 * Id minting is ambient I/O (depends on a clock + entropy source) and the
 * project's convention is that ambient I/O lives behind a port. The
 * `IdGenerator` port in `core/application/ports/idGenerator.ts` is the
 * single mint point — domain code only ever sees a fully-formed string and
 * round-trips it through `TodoId.create` to attach the brand.
 */
export type TodoId = string & { readonly [todoIdBrand]: true };

export const TodoId = {
  create: (id: string): TodoId => {
    if (!UUID_V7_PATTERN.test(id)) {
      throw new BusinessRuleError(TodoErrorCode.InvalidId, "Invalid todo id");
    }
    return id as TodoId;
  },
};

export type TodoTitle = string & { readonly [todoTitleBrand]: true };

/**
 * Internal Zod schema. Deliberately not exported.
 *
 * Server-function input validators must define their own schemas (see
 * `app/components/todo/schema.ts`) so that frontend code never has to
 * import this module — that import would drag the domain factory,
 * `BusinessRuleError`, the UUIDv7 generator, and every transitive
 * domain dependency into the client bundle. Drift between transport
 * rules and domain rules is acceptable: the domain factory below is
 * the authoritative final gate.
 */
const todoTitleSchema = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);

/**
 * Localize Zod's issue-shape dependency. The classic `ZodIssue` type alias
 * is `@deprecated` in Zod v4 (the canonical replacement is `z.core.$ZodIssue`,
 * a `$`-prefixed internal API), so we describe only the structural slice we
 * actually read. A future major release that renames issue codes touches just
 * this helper — every call site keeps working.
 */
function mapTitleIssueToErrorCode(
  issue: { readonly code?: string } | undefined,
): TodoErrorCode {
  if (issue?.code === "too_big") return TodoErrorCode.TitleTooLong;
  // Zod emits `too_small` when the trimmed value is shorter than `min(1)`
  // and `invalid_type` for non-string inputs. Both surface to the user as
  // an empty title, so they collapse to the same code.
  return TodoErrorCode.TitleEmpty;
}

export const TodoTitle = {
  create: (raw: string): TodoTitle => {
    const result = todoTitleSchema.safeParse(raw);
    if (result.success) {
      return result.data as TodoTitle;
    }
    const code = mapTitleIssueToErrorCode(result.error.issues[0]);
    const message =
      code === TodoErrorCode.TitleTooLong
        ? `Todo title exceeds maximum length (${TODO_TITLE_MAX_LENGTH})`
        : "Todo title cannot be empty";
    throw new BusinessRuleError(code, message, result.error);
  },
};
