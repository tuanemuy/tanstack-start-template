import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { handleQueue } from "./handlers";

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  return handleQueue(event);
};

export default { handler };
