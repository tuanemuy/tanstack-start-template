import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";

const TODO_TITLE_MAX_LENGTH = 140;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const todoIdBrand: unique symbol;
declare const todoTitleBrand: unique symbol;

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
