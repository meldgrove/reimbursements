import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { readiness } from "../services/readiness";

/**
 * Health checks (the Django version's /-/healthz and /-/readyz). Both need
 * the X-Health-Token header (HEALTHCHECK_TOKEN) outside development; without
 * it they answer 404, as if they did not exist. They read no settings and
 * call no provider.
 */
const router = new Hono<AppEnv>();

function sameToken(given: string, expected: string): boolean {
  // Security: compare in constant time, so response times tell nothing about the token.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

export function healthAuthorized(token: string | undefined): boolean {
  const settings = config();
  return (
    settings.isDevelopment ||
    (Boolean(settings.HEALTHCHECK_TOKEN) && sameToken(token ?? "", settings.HEALTHCHECK_TOKEN))
  );
}

/** The process runs. */
router.get("/-/healthz", (c) => {
  if (!healthAuthorized(c.req.header("x-health-token"))) return c.notFound();
  c.header("cache-control", "no-store, private");
  return c.json({
    status: "OK",
    version: config().APP_VERSION || null,
    timestamp: new Date().toISOString(),
  });
});

/** The database, the storage, the workspace, the scanner, the sandbox and the worker. */
router.get("/-/readyz", async (c) => {
  if (!healthAuthorized(c.req.header("x-health-token"))) return c.notFound();
  c.header("cache-control", "no-store, private");
  try {
    await getDb().execute(sql`select 1`);
    const result = await readiness();
    const body = { checks: result.checks, oldest_job_age_seconds: result.oldestJobAgeSeconds };
    if (!result.ready) return c.json({ status: "unavailable", ...body }, 503);
    return c.json({ status: "OK", ...body });
  } catch {
    return c.json({ status: "unavailable" }, 503);
  }
});

export default router;
