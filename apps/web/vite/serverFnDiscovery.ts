import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const SERVER_FN_ID = /[0-9a-f]{64}/g;
const MANIFEST_ENTRY = /["']?([0-9a-f]{64})["']?\s*:\s*\{/g;
const RESOLVER_MARKER = "Server function info not found";

/**
 * Makes every `createServerFn` module visible to the TanStack Start compiler
 * before the production server-fn manifest is generated.
 *
 * In RSC mode the manifest (`#tanstack-start-server-fn-resolver`) is rendered
 * once, while the `rsc` environment builds, from the server fns the compiler
 * has transformed so far — at that point only what `@vitejs/plugin-rsc`'s
 * preceding `ssr` scan pass reached. A server fn imported solely from a
 * `"use client"` module is outside that graph: its importer is reachable only
 * through an RSC client reference, and those are unknown until the `rsc` build
 * itself. It is first transformed in the later `client` build, after the
 * manifest is frozen, so calling it in production fails with
 * `Server function info not found`. Dev resolves ids lazily and is unaffected.
 *
 * Emitting the declaring modules as extra entries of the scan pass (detected
 * the same way `@tanstack/react-start-rsc` does, by `build.write === false`)
 * runs the compiler on them in time and leaves the real output untouched.
 *
 * The scan-pass signal is another plugin's internal, so the second plugin is a
 * guard that does not depend on it: it fails the build when the client bundle
 * references a server fn id the manifest lacks, turning a production-only 500
 * into a build error whether the cause is this workaround going stale or a new
 * shape of the upstream bug.
 *
 * Remove once https://github.com/TanStack/router/issues/7943 is fixed.
 */
export function serverFnDiscovery(opts: { srcDirectory: string }): Plugin[] {
  const referenced = new Set<string>();
  const registered = new Set<string>();
  let sawResolver = false;

  const discover: Plugin = {
    name: "repo:server-fn-discovery",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    async buildStart() {
      if (this.environment.config.build.write !== false) return;
      const srcRoot = resolve(this.environment.config.root, opts.srcDirectory);
      for await (const file of glob("**/*.{ts,tsx}", { cwd: srcRoot })) {
        if (file.includes(".test.")) continue;
        const id = resolve(srcRoot, file);
        const code = await readFile(id, "utf8");
        if (code.includes("createServerFn")) {
          this.emitFile({ type: "chunk", id });
        }
      }
    },
  };

  const guard: Plugin = {
    name: "repo:server-fn-manifest-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      if (this.environment.config.build.write === false) return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        if (this.environment.name === "client") {
          for (const [id] of chunk.code.matchAll(SERVER_FN_ID)) {
            referenced.add(id);
          }
        } else if (chunk.code.includes(RESOLVER_MARKER)) {
          sawResolver = true;
          for (const [, id] of chunk.code.matchAll(MANIFEST_ENTRY)) {
            if (id !== undefined) registered.add(id);
          }
        }
      }
    },
    buildApp: {
      order: "post",
      handler: async () => {
        if (!sawResolver) {
          throw new Error(
            "[server-fn-manifest-guard] could not find the server fn resolver in the build output, so the manifest cannot be verified.",
          );
        }
        const missing = [...referenced].filter((id) => !registered.has(id));
        if (missing.length > 0) {
          throw new Error(
            `[server-fn-manifest-guard] the client bundle calls ${missing.length} server fn(s) missing from the production manifest; they would fail with "Server function info not found":\n  - ${missing.join("\n  - ")}`,
          );
        }
      },
    },
  };

  return [discover, guard];
}
