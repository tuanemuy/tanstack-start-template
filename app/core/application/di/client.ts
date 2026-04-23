/**
 * Client-side DI Container.
 *
 * Intentionally empty today. Add browser-only dependencies (analytics clients,
 * feature-flag providers, etc.) here and import from `@/core/application/di/client`.
 *
 * Exposed via a `getContainer()` accessor to mirror the server shape —
 * call sites can stay symmetric across server/client without caring about
 * whether construction happens eagerly or on-demand.
 */
export type Container = Record<string, never>;

export function getContainer(): Container {
  return {};
}
