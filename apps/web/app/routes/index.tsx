import { createFileRoute, Link } from "@tanstack/react-router";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/")({
  head: ({ match }) => {
    const config = match.context?.config;
    if (!config) return {};
    const { meta, links } = buildHead(config, { path: "/" });
    return { meta, links };
  },
  component: LandingPage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function LandingPage() {
  return (
    <main>
      <h1>tanstack-start-template</h1>
      <p>
        TanStack Start + RSC + DDD + Cloudflare のリファレンステンプレート。
      </p>
      <p>
        <Link to="/todo" search={{ page: 1, limit: 20 }}>
          Todo を試す →
        </Link>
      </p>
    </main>
  );
}
