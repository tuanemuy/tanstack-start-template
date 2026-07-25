// Same as `vite.config.cloudflare.ts` minus `@cloudflare/vite-plugin`,
// so the SSR environment falls back to Node's runnable default.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "app",
      // Path is resolved relative to `srcDirectory`; an `app/` prefix
      // makes the plugin silently fall back to the default CF entry.
      server: { entry: "server.node.ts" },
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
  // libSQL ships a native addon; letting vite pre-bundle it breaks dev with
  // `target is not defined` (500 on every route). Keep it external on both the
  // SSR graph and the client optimizer so Node `require`s the real binary.
  ssr: {
    external: ["@libsql/client", "libsql"],
  },
  optimizeDeps: {
    exclude: ["@libsql/client", "libsql"],
  },
});
