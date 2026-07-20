// AWS Lambda build target. Points the server entry at `server.aws.ts` so
// the bundle exposes the API Gateway / Function URL handler.
//
// Unlike `vite.config.node.ts` (which expects `node_modules/` to be
// available next to the bundle), this config forces SSR `noExternal: true`
// so the emitted `dist/server/server.aws.js` is self-contained and can be
// uploaded to Lambda via `Code.fromAsset("dist/server")` without any
// runtime dependency on `node_modules/`.
//
// `@aws-sdk/*` is excluded from bundling: the Lambda Node.js 20+ runtime
// ships AWS SDK v3 in `/var/runtime/node_modules`, so bundling it would
// only bloat the artifact (and risk version drift).
//
// Worker Lambdas (relay / consumer / pruner / dlq) live under
// `app/worker/aws/` and are bundled via the CDK app's NodejsFunction
// constructs — they don't go through Vite.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Packages provided by the Lambda runtime; never bundle them. Vite's
// `ssr.external` accepts only string identifiers (Vite v8 typing), so
// the canonical list is here. `rollupOptions.external` mirrors it as a
// regex so any subpath import (`@aws-sdk/client-sqs/dist-cjs/...`) is
// also externalised — both passes are needed.
const lambdaRuntimePackages = [
  "@aws-sdk/client-lambda",
  "@aws-sdk/client-secrets-manager",
  "@aws-sdk/client-sqs",
];
const lambdaRuntimeProvidedSubpaths = [/^@aws-sdk\//];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Force every npm dep into the server bundle so Lambda doesn't need
    // a `node_modules/` folder at runtime. Exceptions: AWS SDK packages
    // that Lambda already provides.
    noExternal: true,
    external: lambdaRuntimePackages,
  },
  build: {
    rollupOptions: {
      external: lambdaRuntimeProvidedSubpaths,
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "app",
      // Path is resolved relative to `srcDirectory`; an `app/` prefix
      // makes the plugin silently fall back to the default CF entry.
      server: { entry: "server.aws.ts" },
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
