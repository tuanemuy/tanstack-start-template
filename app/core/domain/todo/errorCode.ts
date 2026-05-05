export const TodoErrorCode = {
  InvalidId: "TODO_INVALID_ID",
  TitleEmpty: "TODO_TITLE_EMPTY",
  TitleTooLong: "TODO_TITLE_TOO_LONG",
  InvalidStatus: "TODO_INVALID_STATUS",
} as const;

export type TodoErrorCode = (typeof TodoErrorCode)[keyof typeof TodoErrorCode];
