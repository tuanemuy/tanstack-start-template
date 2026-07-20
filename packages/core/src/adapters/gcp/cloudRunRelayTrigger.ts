import type { Logger } from "@repo/core/application/ports/logger";
import type { RelayTrigger } from "@repo/core/application/ports/relayTrigger";
import type { GoogleAuth } from "google-auth-library";

export type CloudRunRelayTriggerDeps = Readonly<{
  auth: GoogleAuth;
  relayUrl: string;
  logger: Logger;
}>;

/**
 * Cloud Run service-to-service {@link RelayTrigger}. `kick()` POSTs to
 * the relay service with an OIDC ID token (audience = service origin)
 * and detaches without awaiting the response. Failures are logged and
 * swallowed because the Cloud Scheduler safety-net cron re-attempts the
 * drain on the next tick.
 */
export class CloudRunRelayTrigger implements RelayTrigger {
  private readonly auth: GoogleAuth;
  private readonly relayUrl: string;
  private readonly logger: Logger;
  private readonly audience: string;

  constructor(deps: CloudRunRelayTriggerDeps) {
    this.auth = deps.auth;
    this.relayUrl = deps.relayUrl;
    this.logger = deps.logger;
    const parsed = new URL(deps.relayUrl);
    this.audience = `${parsed.protocol}//${parsed.host}`;
  }

  kick(): void {
    void (async () => {
      try {
        const client = await this.auth.getIdTokenClient(this.audience);
        await client.request({
          url: this.relayUrl,
          method: "POST",
          data: {},
        });
      } catch (cause) {
        this.logger.error(
          "[relay-trigger] cloud run authenticated POST failed",
          { cause },
        );
      }
    })();
  }
}
