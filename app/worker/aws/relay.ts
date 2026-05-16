import type { ScheduledEvent } from "aws-lambda";
import { runRelayTick } from "./handlers";

/**
 * Trigger surface for the relay Lambda:
 *   - EventBridge Scheduler (`ScheduledEvent`) — periodic safety net.
 *   - Async `lambda:Invoke` from the request path (event payload is
 *     ignored; the call is just a kick).
 *
 * Both paths funnel into the same `runRelayTick` so a single drain
 * policy applies regardless of trigger.
 */
export const handler = async (
  _event: ScheduledEvent | unknown,
): Promise<{ processed: number }> => {
  return runRelayTick();
};

export default { handler };
