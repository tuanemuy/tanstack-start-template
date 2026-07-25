// Cloud Run build target. Points the server entry at `server.gcp.ts` so
// the bundle exposes the role-dispatching boot for the `app` / `relay`
// / `consumer` / `dlq` services.
//
// Unlike the AWS config (which forces full bundle inlining to satisfy
// the Lambda zip), Cloud Run runs a docker container with full
// `node_modules/` access, so the default Vite externalisation is fine.
// `@google-cloud/*` ships gRPC native modules that don't bundle
// reliably; we explicitly externalise them and the Dockerfile installs
// them via `pnpm install --prod` in the runtime stage.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// `@libsql/client` is here for the same reason as the gRPC packages:
// inlining it strands the `require("@libsql/<platform>")` native lookup
// inside the bundle, where it can no longer resolve through the
// package's own node_modules.
const gcpRuntimePackages = [
  "@google-cloud/pubsub",
  "@google-cloud/secret-manager",
  "google-auth-library",
  "@libsql/client",
];
const gcpRuntimeProvidedSubpaths = [
  /^@google-cloud\//,
  /^google-auth-library(\/|$)/,
  /^@libsql\//,
  /^libsql(\/|$)/,
];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: gcpRuntimePackages,
  },
  build: {
    rollupOptions: {
      external: gcpRuntimeProvidedSubpaths,
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "app",
      // Path is resolved relative to `srcDirectory`; an `app/` prefix
      // makes the plugin silently fall back to the default CF entry.
      server: { entry: "server.gcp.ts" },
      rsc: { enabled: true },
    }),
    rsc(),
    viteReact(),
  ],
  server: {
    port: 3000,
    host: true,
    watch: {
      ignored: ["**/.direnv/**"],
    },
  },
});
