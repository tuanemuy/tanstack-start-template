import {
  InvocationType,
  InvokeCommand,
  type LambdaClient,
} from "@aws-sdk/client-lambda";
import type { Logger } from "@/core/application/ports/logger";
import type { RelayTrigger } from "@/core/application/ports/relayTrigger";

export type LambdaInvokeRelayTriggerDeps = Readonly<{
  client: LambdaClient;
  // Function name or ARN of the relay Lambda.
  functionName: string;
  logger: Logger;
}>;

/**
 * AWS Lambda implementation of {@link RelayTrigger}.
 *
 * `kick()` issues `InvokeCommand({ InvocationType: "Event" })` against the
 * relay Lambda. Lambda's async invoke path internally queues the request
 * and returns immediately, so no `waitUntil` bridge is needed — the AWS
 * SDK call resolves before the relay function actually runs.
 *
 * Lifecycle: the kick is fire-and-forget via a detached promise. Lambda's
 * default `context.callbackWaitsForEmptyEventLoop = true` keeps the
 * execution sandbox alive until the SDK call resolves, so the invoke is
 * not cancelled when the HTTP response is returned. The trade-off is that
 * the response is held until the SDK call settles (typically tens of ms).
 * If that latency matters, set `callbackWaitsForEmptyEventLoop = false`
 * in the request entry and accept that drops fall back to the
 * EventBridge safety-net cron.
 *
 * Errors are logged and swallowed: the EventBridge Scheduler safety-net
 * cron is the authoritative trigger.
 */
export class LambdaInvokeRelayTrigger implements RelayTrigger {
  private readonly client: LambdaClient;
  private readonly functionName: string;
  private readonly logger: Logger;

  constructor(deps: LambdaInvokeRelayTriggerDeps) {
    this.client = deps.client;
    this.functionName = deps.functionName;
    this.logger = deps.logger;
  }

  kick(): void {
    void (async () => {
      try {
        await this.client.send(
          new InvokeCommand({
            FunctionName: this.functionName,
            InvocationType: InvocationType.Event,
          }),
        );
      } catch (cause) {
        this.logger.error("[relay-trigger] lambda async invoke failed", {
          cause,
        });
      }
    })();
  }
}
