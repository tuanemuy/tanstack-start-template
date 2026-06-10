import { createRouter } from "@tanstack/react-router";
import { RoutePendingFallback } from "./components/ui/RoutePendingFallback";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Generic, route-level navigation pending UI for routes whose loader
    // genuinely blocks. Routes that stream their own content via <Suspense>
    // (e.g. /todo, whose loader forwards an unresolved RSC promise and settles
    // instantly) never trigger this — they use a per-fragment skeleton instead.
    defaultPendingComponent: RoutePendingFallback,
    // Skip the fallback for sub-200ms navigations so it doesn't flash...
    defaultPendingMs: 200,
    // ...and once shown, keep it up for at least 300ms to avoid a flicker.
    defaultPendingMinMs: 300,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
