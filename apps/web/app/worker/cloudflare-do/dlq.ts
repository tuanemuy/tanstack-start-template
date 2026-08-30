import { handleDlq } from "./handlers";

export type { DlqEnv } from "./handlers";

export default {
  queue: handleDlq,
};
