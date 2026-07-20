import { BusinessRuleError } from "@repo/core/domain/error";
import { TodoErrorCode } from "./errorCode";

const TODO_TITLE_MAX_LENGTH = 140;

declare const todoIdBrand: unique symbol;
declare const todoTitleBrand: unique symbol;

export type TodoId = string & { readonly [todoIdBrand]: true };

// Domain treats the id as an opaque, non-empty string. The choice of id
// format (UUIDv7 in this template) is owned by `IdGenerator` and verified
// by storage adapters on rehydration — keeping the regex out of the
// domain lets the generator be swapped (ULID, KSUID, etc.) without
// touching value-object code.
export const TodoId = {
  create: (id: string): TodoId => {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(TodoErrorCode.InvalidId, "Invalid todo id");
    }
    return trimmed as TodoId;
  },
};

export type TodoTitle = string & { readonly [todoTitleBrand]: true };

export const TodoTitle = {
  create: (raw: string): TodoTitle => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(
        TodoErrorCode.TitleEmpty,
        "Todo title cannot be empty",
      );
    }
    if (trimmed.length > TODO_TITLE_MAX_LENGTH) {
      throw new BusinessRuleError(
        TodoErrorCode.TitleTooLong,
        `Todo title exceeds maximum length (${TODO_TITLE_MAX_LENGTH})`,
      );
    }
    return trimmed as TodoTitle;
  },
};

export type TodoStatus = "active" | "completed";

export const TodoStatus = {
  create: (raw: string): TodoStatus => {
    if (raw !== "active" && raw !== "completed") {
      throw new BusinessRuleError(
        TodoErrorCode.InvalidStatus,
        `Invalid todo status: ${raw}`,
      );
    }
    return raw;
  },
};
