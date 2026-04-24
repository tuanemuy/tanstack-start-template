import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";
import appCss from "../styles/index.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "TanStack Start Template" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  // Last-resort error boundary. TanStack Router bubbles errors from the
  // deepest matching route up toward the root: if a child route defines
  // its own `errorComponent` it catches the error there and the root
  // handler does not fire. Errors from the root route itself (loader,
  // render, transport) or from unmatched paths land here.
  errorComponent: ({ error }) => (
    <RootDocument>
      <div>
        <h1>Something went wrong</h1>
        <pre>{sanitizeRouteError(error)}</pre>
      </div>
    </RootDocument>
  ),
  notFoundComponent: () => (
    <RootDocument>
      <div>
        <h1>404 Not Found</h1>
      </div>
    </RootDocument>
  ),
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
        <Scripts />
      </body>
    </html>
  );
}
