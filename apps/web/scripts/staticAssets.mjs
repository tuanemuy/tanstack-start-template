// Shared by the Node and GCP launchers. Plain ESM JavaScript for the same
// reason they are: the production image `node`-executes it without `tsx`.
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/**
 * Wraps the bundled server's fetch handler so the client build is served
 * ahead of it.
 *
 * The bundle only renders and runs server functions; nothing in it serves
 * `dist/client`. On Cloudflare the ASSETS binding does that and on AWS
 * CloudFront + S3 do, but a plain Node process has no such layer in front of
 * it — without this the page's scripts 404 and it never hydrates.
 *
 * @param {string} serverEntry Absolute path of the bundled server entry
 *   (`dist/server/server.*.js`); the client build is its sibling `dist/client`.
 * @param {(request: Request) => Promise<Response>} fetch
 * @returns {(request: Request) => Response | Promise<Response>}
 */
export function withStaticAssets(serverEntry, fetch) {
  const root = path.resolve(path.dirname(serverEntry), "../client");
  const app = new Hono();
  app.use(
    "/assets/*",
    serveStatic({
      root,
      // Vite content-hashes every file it emits under `assets/`, so a given URL
      // never changes content.
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use("*", serveStatic({ root }));
  app.all("*", (c) => fetch(c.req.raw));
  return app.fetch;
}
