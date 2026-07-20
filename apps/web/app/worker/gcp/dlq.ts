import { handleDlq } from "./handlers";

// INVARIANT: every code path must end in 204. The DLQ has no further
// dead-letter target, so a non-2xx response (or an uncaught throw)
// makes Pub/Sub redeliver the same message until retention expires.
export const fetch = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let envelope: unknown;
  try {
    envelope = await request.json();
  } catch (cause) {
    console.error("[worker.gcp.dlq] body is not valid JSON", cause);
    return new Response(null, { status: 204 });
  }
  try {
    const result = await handleDlq(envelope);
    return new Response(result.body ?? null, { status: result.status });
  } catch (cause) {
    console.error("[worker.gcp.dlq] handler threw — acking anyway", cause);
    return new Response(null, { status: 204 });
  }
};

export default { fetch };
