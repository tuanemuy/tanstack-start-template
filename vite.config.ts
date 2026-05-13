import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      srcDirectory: "app",
      rsc: { enabled: true },
    }),
    rsc(),
    viteReact(),
    tsconfigPaths(),
  ],
  server: {
    port: 3000,
    host: true,
    watch: {
      ignored: ["**/.direnv/**"],
    },
  },
});
