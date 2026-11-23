import type { MiddlewareHandler } from "hono";
import { config } from "../config";
import type { AppEnv } from "./env";

/**
 * Sends requests that arrived over plain HTTP to the HTTPS address, as the
 * Django version's SECURE_SSL_REDIRECT did outside development. Behind the
 * reverse proxy, which ends TLS, the request counts as HTTPS when
 * TRUST_PROXY_HEADERS is on and X-Forwarded-Proto says https (Django's
 * SECURE_PROXY_SSL_HEADER; the proxy must replace that header, and the
 * app's port is published only on the server itself). The target is
 * APP_URL's origin, never the request's Host. Health checks reach the
 * container directly over HTTP and are never redirected.
 */
export const httpsRedirect: MiddlewareHandler<AppEnv> = async (c, next) => {
  const settings = config();
  if (settings.isDevelopment || !settings.APP_URL.startsWith("https://")) return next();
  if (c.req.path === "/-/healthz" || c.req.path === "/-/readyz") return next();
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (settings.TRUST_PROXY_HEADERS && forwarded === "https") return next();
  const url = new URL(c.req.url);
  return c.redirect(`${new URL(settings.APP_URL).origin}${url.pathname}${url.search}`, 301);
};
