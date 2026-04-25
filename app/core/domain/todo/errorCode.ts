/**
 * Error codes owned by the Todo domain.
 *
 * `as const` keeps the literal union usable both as a type
 * (`BusinessRuleError<TodoErrorCode>`) and a value
 * (`error.code === TodoErrorCode.TitleTooLong`).
 */
export const TodoErrorCode = {
  InvalidId: "TODO_INVALID_ID",
  TitleEmpty: "TODO_TITLE_EMPTY",
  TitleTooLong: "TODO_TITLE_TOO_LONG",
  UnknownEventType: "TODO_UNKNOWN_EVENT_TYPE",
} as const;

export type TodoErrorCode = (typeof TodoErrorCode)[keyof typeof TodoErrorCode];
