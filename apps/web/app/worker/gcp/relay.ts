import { runRelayTick } from "./handlers";

export const fetch = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  try {
    const result = await runRelayTick();
    return Response.json(result);
  } catch (cause) {
    console.error("[worker.gcp.relay] tick threw", cause);
    return new Response("relay tick failed", { status: 500 });
  }
};

export default { fetch };
