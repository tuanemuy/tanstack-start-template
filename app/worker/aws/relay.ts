import { runRelayTick } from "./handlers";

// Triggered by EventBridge Scheduler (periodic safety net) and async
// `lambda:Invoke` from the request path. The event payload is unused —
// both paths funnel into the same `runRelayTick`.
export const handler = async (
  _event: unknown,
): Promise<{ processed: number }> => {
  return runRelayTick();
};

export default { handler };
