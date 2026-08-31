import { runPruneTick } from "./handlers";

export const fetch = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  try {
    const result = await runPruneTick();
    return Response.json(result);
  } catch (cause) {
    console.error("[worker.gcp.pruner] tick threw", cause);
    return new Response("prune tick failed", { status: 500 });
  }
};

export default { fetch };
