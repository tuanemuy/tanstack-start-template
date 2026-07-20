import { handleQueue } from "./handlers";

export type { ConsumerEnv } from "./handlers";

export default {
  queue: handleQueue,
};
