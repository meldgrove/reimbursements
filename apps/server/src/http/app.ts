import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { AppError, zodFieldErrors } from "./errors";
import { applySettings, authenticate, requestId, requestLimits, requestLog, sameOrigin } from "./middleware";
import { compression } from "./compression";
import { httpsRedirect } from "./https";
import { webApp } from "./static";
import { config } from "../config";
import { API_MODULES, ROOT_MODULES } from "../modules";
import health from "../modules/health";
import assets from "../modules/assets";
import { signInRoutes } from "./sign-in";
import { logger } from "../logger";
import { errorReportingSources, tracingMiddleware } from "../error-reporting";

/**
 * PostgreSQL errors of a request that ran into another one at the same time:
 * unique violation, deadlock, serialization failure. Trying again gives the
 * right answer.
 */
const CONCURRENT_CHANGE_CODES = new Set(["23505", "40P01", "40001"]);

/** The SQLSTATE of a database error, also when Drizzle wrapped it (`cause`). */
export function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

/** A 409 for a request that ran into a concurrent change; null for other errors. */
export function concurrentChangeResponse(error: Error, c: Context<AppEnv>) {
  const code = databaseErrorCode(error);
  if (!code || !CONCURRENT_CHANGE_CODES.has(code)) return null;
  logger.warn(
    { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}`, code },
    "request ran into a concurrent change",
  );
  return c.json(
    {
      error: { code: "concurrent_change", message: "Someone else changed this at the same time. Try again." },
    },
    409,
  );
}

/** The sign-in provider's origin: sign-out may send the browser there. */
function providerOrigin(): string[] {
  try {
    return config().oidcIssuer ? [new URL(config().oidcIssuer).origin] : [];
  } catch {
    return [];
  }
}

/** Responses anyone may cache: built assets and the favicon. Everything else can be private. */
const PUBLIC_PATHS = ["/assets/", "/favicon/", "/favicon.svg"];

export function createApp() {
  const app = new Hono<AppEnv>();
  const tracing = tracingMiddleware(app);
  if (tracing) app.use("*", tracing);
  app.use("*", requestId, requestLog, compression());
  app.use("*", httpsRedirect);
  // A route may set a stricter policy (the favicon); it wins over the app's below.
  app.use("*", async (c, next) => {
    await next();
    const policy = c.get("contentSecurityPolicy");
    if (policy) c.res.headers.set("content-security-policy", policy);
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...errorReportingSources()],
        formAction: ["'self'", ...providerOrigin()],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "same-origin",
      xFrameOptions: "DENY",
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config().APP_URL.startsWith("https://")
        ? "max-age=31536000; includeSubDomains"
        : false,
      // The signature pad needs none of these.
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );
  // Pages and answers carry personal data: nothing but built assets may be cached.
  app.use("*", async (c, next) => {
    await next();
    if (PUBLIC_PATHS.some((prefix) => c.req.path.startsWith(prefix))) return;
    const current = c.res.headers.get("cache-control") ?? "";
    if (!current.includes("immutable") && current !== "no-cache")
      c.header("cache-control", "no-store, private");
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: { code: error.code, message: error.message, fields: error.fields, ...error.extra } },
        error.status,
      );
    }
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_error",
            message: "Check the highlighted fields",
            fields: zodFieldErrors(error),
          },
        },
        422,
      );
    }
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: { code: error.status === 413 ? "request_too_large" : "bad_request", message: error.message },
        },
        error.status,
      );
    }
    const concurrent = concurrentChangeResponse(error, c);
    if (concurrent) return concurrent;
    logger.error(
      { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}` },
      "unhandled error",
    );
    return c.json({ error: { code: "internal_error", message: "Something went wrong. Try again." } }, 500);
  });

  // Health checks answer without the settings (and without the database for /-/healthz).
  app.route("/", health);

  app.use("*", applySettings, requestLimits);
  app.route("/", assets);
  app.route("/", signInRoutes());
  // Routes outside the API that prove themselves (the MailerSend webhook).
  for (const module of ROOT_MODULES) app.route("/", module);

  const api = new Hono<AppEnv>();
  api.use("*", sameOrigin, authenticate);
  for (const module of API_MODULES) api.route("/", module);
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  app.route("/", webApp());
  return app;
}
