// Queue consumer Worker. Sole responsibility: drain dispatched events
// from the events Queue and run subscribers (read-model projection,
// external webhooks, etc.).
//
// Deploys via `wrangler.consumer.toml`. Has the Queue consumer binding
// plus D1 so subscribers can read/write through the application
// container. Trim D1 if your consumers are stateless.
import { handleQueue } from "./handlers";

export type { ConsumerEnv } from "./handlers";

export default {
  queue: handleQueue,
};
