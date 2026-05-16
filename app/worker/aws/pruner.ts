import type { ScheduledEvent } from "aws-lambda";
import { runPruneTick } from "./handlers";

export const handler = async (
  _event: ScheduledEvent,
): Promise<{ deleted: number }> => {
  return runPruneTick();
};

export default { handler };
