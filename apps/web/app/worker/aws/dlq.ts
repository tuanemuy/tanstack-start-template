import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { handleDlq } from "./handlers";

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  return handleDlq(event);
};

export default { handler };
