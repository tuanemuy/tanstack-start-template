/**
 * Error codes owned by the Todo domain.
 *
 * Keep the constant a `const` object (not a plain type alias) so the narrowed
 * union below is usable as both a type (for `BusinessRuleError<TodoErrorCode>`)
 * and a value (for `error.code === TodoErrorCode.TitleTooLong`). The literal
 * union is what `BusinessRuleError<TCode>` ultimately narrows against in catch
 * blocks.
 */
export const TodoErrorCode = {
  InvalidId: "TODO_INVALID_ID",
  TitleEmpty: "TODO_TITLE_EMPTY",
  TitleTooLong: "TODO_TITLE_TOO_LONG",
  UnknownEventType: "TODO_UNKNOWN_EVENT_TYPE",
  UnsupportedEventSchema: "TODO_UNSUPPORTED_EVENT_SCHEMA",
  /**
   * Payload failed to decode (malformed data on an already-persisted outbox
   * row, typically corrupt branded id or missing field). Surfaces through
   * `decodeTodoEvent`'s Result channel rather than as a throw.
   */
  EventDecodeFailed: "TODO_EVENT_DECODE_FAILED",
} as const;

export type TodoErrorCode = (typeof TodoErrorCode)[keyof typeof TodoErrorCode];
