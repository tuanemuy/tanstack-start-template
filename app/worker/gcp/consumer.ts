import { handleQueue } from "./handlers";

export const fetch = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let envelope: unknown;
  try {
    envelope = await request.json();
  } catch (cause) {
    console.error("[worker.gcp.consumer] body is not valid JSON", cause);
    return new Response(null, { status: 204 });
  }
  try {
    const result = await handleQueue(envelope);
    return new Response(result.body ?? null, { status: result.status });
  } catch (cause) {
    // Cold-start failures (e.g. Turso unreachable during `bootWorker`)
    // escape `handleQueue`'s own try/catch. Nack so Pub/Sub redelivers.
    console.error("[worker.gcp.consumer] handler threw", cause);
    return new Response("handler threw", { status: 500 });
  }
};

export default { fetch };
