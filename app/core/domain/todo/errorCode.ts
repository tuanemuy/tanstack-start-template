export const TodoErrorCode = {
  InvalidId: "TODO_INVALID_ID",
  TitleEmpty: "TODO_TITLE_EMPTY",
  TitleTooLong: "TODO_TITLE_TOO_LONG",
  UnknownEventType: "TODO_UNKNOWN_EVENT_TYPE",
  UnsupportedEventSchema: "TODO_UNSUPPORTED_EVENT_SCHEMA",
} as const;

export type TodoErrorCode = (typeof TodoErrorCode)[keyof typeof TodoErrorCode];
