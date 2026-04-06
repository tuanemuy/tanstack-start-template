/**
 * Client-side DI Container
 *
 * This file provides the concrete implementation of the client container
 * with all necessary adapters for browser-side operations.
 */

import type { Container } from "@/core/application/container/client";

function createContainer(): Container {
  return {
    // Add client-side dependencies here
  };
}

export const container = createContainer();
