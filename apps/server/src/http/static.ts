import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "./env";
import { config } from "../config";
import { SERVER_ROOT } from "../paths";
import { withErrorReportingSettings } from "../error-reporting";

/**
 * The pages of the web app: index.html answers them whatever the request
 * accepts, as the Django version's pages did (a link checker or curl asks
 * for any type). Other paths get index.html only when a browser asks for a
 * page (the app then shows "Not found").
 */
const PAGES = /^\/(?:|datenschutz\/?|f\/[^/]+\/?|received\/[^/]+\/?|admin(?:\/.*)?)$/;

/**
 * The built web app (apps/web/dist): hashed assets, the theme script, and
 * index.html for every page of both areas (participant pages and /admin/).
 * Text assets go out as their brotli or gzip copies from the build
 * (scripts/compress-assets.mjs) when the browser accepts them.
 */
export function webApp() {
  const root = config().WEB_DIST_DIR ?? path.resolve(SERVER_ROOT, "../web/dist");
  const relativeRoot = path.relative(process.cwd(), root) || ".";
  const app = new Hono<AppEnv>();
  app.use(
    "/assets/*",
    serveStatic({
      root: relativeRoot,
      precompressed: true,
      onFound: (_path, c) => {
        c.header("cache-control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use("/favicon.svg", serveStatic({ root: relativeRoot, precompressed: true }));
  // Sets the person's Appearance before the page shows (index.html). Not
  // hashed: the browser checks it each time (no-cache, which the app keeps).
  let themeScript: Buffer | undefined;
  app.get("/theme.js", async (c) => {
    try {
      themeScript ??= await readFile(path.join(root, "theme.js"));
    } catch {
      return c.notFound();
    }
    return c.body(new Uint8Array(themeScript), 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
  });
  let indexHtml: string | undefined;
  app.get("*", async (c) => {
    if (!PAGES.test(c.req.path) && !c.req.header("accept")?.includes("text/html")) return c.notFound();
    try {
      indexHtml ??= withErrorReportingSettings(await readFile(path.join(root, "index.html"), "utf8"));
    } catch {
      return c.text("The web app is not built. Run `npm run build` or use the Vite dev server.", 503);
    }
    c.header("cache-control", "no-cache");
    // The development sign-in does not exist elsewhere: the web app shows "Not found", with its status.
    const missing =
      /^\/admin\/login\/dev\/?$/.test(c.req.path) && !(config().isDevelopment && config().DEV_LOGIN);
    return c.html(indexHtml, missing ? 404 : 200);
  });
  return app;
}
