import {
  InvocationType,
  InvokeCommand,
  type LambdaClient,
} from "@aws-sdk/client-lambda";
import type { Logger } from "@repo/core/application/ports/logger";
import type { RelayTrigger } from "@repo/core/application/ports/relayTrigger";

export type LambdaInvokeRelayTriggerDeps = Readonly<{
  client: LambdaClient;
  // Function name or ARN of the relay Lambda.
  functionName: string;
  logger: Logger;
}>;

/**
 * AWS Lambda implementation of {@link RelayTrigger}. `kick()` issues an
 * async `Invoke` against the relay Lambda; Lambda's async path queues
 * internally so no `waitUntil` bridge is needed. Errors are logged and
 * swallowed — the EventBridge safety-net cron is the authoritative trigger.
 *
 * The kick is detached, so the request-path Lambda keeps the sandbox alive
 * until the SDK call settles (default `callbackWaitsForEmptyEventLoop`).
 * Flip that off in the request entry if the added tens of ms matter.
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
