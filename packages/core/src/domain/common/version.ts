import { BusinessRuleError } from "@repo/core/domain/error";

declare const versionBrand: unique symbol;

/**
 * Monotonic revision counter for optimistic locking on aggregate roots.
 * The brand pushes the non-negative-integer invariant to construction time
 * so arithmetic sites cannot produce an invalid value — go through
 * `initial` / `next` / `create` rather than raw number ops.
 */
export type Version = number & { readonly [versionBrand]: true };

export const Version = {
  initial: (): Version => 0 as Version,
  create: (raw: number): Version => {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new BusinessRuleError("INVALID_VERSION", `Invalid version: ${raw}`);
    }
    return raw as Version;
  },
  next: (v: Version): Version => ((v as number) + 1) as Version,
};
