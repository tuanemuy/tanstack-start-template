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
