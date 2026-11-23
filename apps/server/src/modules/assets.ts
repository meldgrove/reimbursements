import { Hono, type Context } from "hono";
import type { AppEnv } from "../http/env";
import { loadFavicon } from "../services/app-settings";

/**
 * Routes of both areas outside the API: the favicon of the Appearance
 * settings, and the addresses of the Django version's admin pages, which
 * bookmarks and old emails still link to.
 */
const router = new Hono<AppEnv>();

/** The favicon from the Appearance settings. Its link names the digest of its content. */
const favicon = async (c: Context<AppEnv>) => {
  const stored = await loadFavicon();
  if (!stored) return c.notFound();
  // An SVG favicon opened on its own must not run anything.
  c.set("contentSecurityPolicy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // Cached for good when its link names the current digest.
  c.header(
    "cache-control",
    c.req.param("digest") === stored.digest ? "public, max-age=31536000, immutable" : "public, no-cache",
  );
  c.header("content-type", stored.type);
  return c.body(new Uint8Array(stored.content));
};
router.get("/favicon/:digest{[A-Za-z0-9_-]+}", favicon);
router.get("/favicon/:digest{[A-Za-z0-9_-]+}/", favicon);

/** Where an address of the Django version's admin area is now; null for none. */
export function legacyAdminPath(path: string): string | null {
  const routes: [RegExp, (match: RegExpExecArray) => string][] = [
    [/^\/admin\/portal\/?$/, () => "/admin/claims"],
    [/^\/admin\/portal\/claim\/?$/, () => "/admin/claims"],
    [
      /^\/admin\/portal\/claim\/([0-9a-f-]{36})(\/.*)?$/i,
      (match) => `/admin/claims/${match[1]!.toLowerCase()}`,
    ],
    [/^\/admin\/portal\/form\/?$/, () => "/admin/forms"],
    [/^\/admin\/portal\/form\/add\/?.*$/, () => "/admin/forms/new"],
    [/^\/admin\/portal\/form\/(\d+)(\/.*)?$/, (match) => `/admin/forms/${match[1]}`],
    [/^\/admin\/portal\/formtemplate\/?$/, () => "/admin/templates"],
    [/^\/admin\/portal\/formtemplate\/add\/?.*$/, () => "/admin/templates/new"],
    [/^\/admin\/portal\/formtemplate\/(\d+)(\/.*)?$/, (match) => `/admin/templates/${match[1]}`],
    [/^\/admin\/portal\/privacynotice\/add\/?.*$/, () => "/admin/privacy-notice/new"],
    [/^\/admin\/portal\/privacynotice(\/.*)?$/, () => "/admin/privacy-notice"],
    [/^\/admin\/portal\/appsettings(\/.*)?$/, () => "/admin/general"],
    [/^\/admin\/portal\/appearance(\/.*)?$/, () => "/admin/appearance"],
    [/^\/admin\/portal\/updates(\/.*)?$/, () => "/admin/updates"],
    [/^\/admin\/updates(\/.*)?\/$/, () => "/admin/updates"],
    [/^\/admin\/(login|no-access|settings|search)\/$/, (match) => `/admin/${match[1]}`],
    [/^\/admin\/logout\/?$/, () => "/admin"],
  ];
  for (const [pattern, target] of routes) {
    const match = pattern.exec(path);
    if (match) return target(match);
  }
  return null;
}

router.get("/admin/*", async (c, next) => {
  const target = legacyAdminPath(c.req.path);
  if (!target) return next();
  return c.redirect(target, 301);
});

export default router;
