/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { DomainEvent } from "@/core/domain/common/event";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    MIGRATIONS: D1Migration[];
    EVENTS_QUEUE: Queue<DomainEvent>;
    APP_URL: string;
  }
}
