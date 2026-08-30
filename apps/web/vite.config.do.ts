import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Durable-Object runtime variant of vite.config.cloudflare.ts — same
// plugin stack, pointed at wrangler.do.toml / server.cloudflare-do.ts.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    cloudflare({
      configPath: "./wrangler.do.toml",
      // Declare `rsc` as a child of the workerd-backed `ssr` env so the
      // RSC plugin's module runner is initialised inside the worker.
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
    }),
    tanstackStart({
      srcDirectory: "app",
      // Path is resolved relative to `srcDirectory`; an `app/` prefix
      // makes the plugin silently fall back to the default CF entry.
      server: { entry: "server.cloudflare-do.ts" },
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
