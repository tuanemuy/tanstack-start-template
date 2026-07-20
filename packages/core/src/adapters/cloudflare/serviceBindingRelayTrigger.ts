import type { Fetcher } from "@cloudflare/workers-types";
import type { Logger } from "@repo/core/application/ports/logger";
import type { RelayTrigger } from "@repo/core/application/ports/relayTrigger";

// The bound relay Worker only inspects the request method / path, not
// the host — `relay.invalid` keeps it impossible to confuse with a
// real public URL while still being a syntactically valid Request URL.
const KICK_URL = "https://relay.invalid/kick";

/**
 * Cloudflare Service Binding implementation of {@link RelayTrigger}.
 *
 * `kick()` enqueues a `RELAY.fetch(...)` against `ExecutionContext.waitUntil`
 * so the call outlives the originating request. Errors are logged and
 * swallowed: the relay's safety-net cron is the authoritative trigger.
 */
export class ServiceBindingRelayTrigger implements RelayTrigger {
  constructor(
    private readonly relay: Fetcher,
    private readonly waitUntil: (promise: Promise<unknown>) => void,
    private readonly logger: Logger,
  ) {}

  kick(): void {
    this.waitUntil(
      (async () => {
        try {
          await this.relay.fetch(KICK_URL, { method: "POST" });
        } catch (cause) {
          this.logger.error("[relay-trigger] service binding kick failed", {
            cause,
          });
        }
      })(),
    );
  }
}
