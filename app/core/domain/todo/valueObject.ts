import { z } from "zod";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";

const TODO_TITLE_MAX_LENGTH = 140;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const todoIdBrand: unique symbol;
declare const todoTitleBrand: unique symbol;

/**
 * Branded `TodoId`. Aggregate ids are server-minted via `IdGenerator`, so
 * any non-UUIDv7 value reaching `TodoId.create` indicates corrupt storage
 * or a programming bug.
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

const todoTitleSchema = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);

function mapTitleIssueToErrorCode(
  issue: { readonly code?: string } | undefined,
): TodoErrorCode {
  if (issue?.code === "too_big") return TodoErrorCode.TitleTooLong;
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
