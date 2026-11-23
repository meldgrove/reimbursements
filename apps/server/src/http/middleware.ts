import { randomUUID } from "node:crypto";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { config, originAllowed } from "../config";
import type { User } from "../db/schema";
import { currentSession } from "../auth/session";
import { isFormEditor, isTemplateAdmin } from "../auth/roles";
import { logger } from "../logger";
import { t } from "../i18n";
import { applied, loadSettings, requestLanguage } from "../services/app-settings";
import type { AppEnv } from "./env";
import { AppError, badRequest, parseWith, unauthorized } from "./errors";

/**
 * Each request gets an ID of its own for the logs and the X-Request-ID header,
 * as in the Django version: a client's X-Request-ID is not taken, since logs
 * must not carry what a client chose to send.
 */
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

/** Logs each request by its route pattern: paths and queries can carry names and form slugs. */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = performance.now();
  await next();
  const path = c.req.path;
  if (path.startsWith("/-/") || path.startsWith("/assets/")) return;
  logger.info(
    {
      requestId: c.get("requestId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    },
    "request",
  );
};

/**
 * Applies the General settings to the request (the Django version's
 * AppSettingsMiddleware): the language (English in the admin area), the
 * timezone, date and number format, for everything the request writes.
 * Health checks answer without the database.
 */
export const applySettings: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/-/")) return next();
  const general = await loadSettings();
  c.set("settings", general);
  const language = requestLanguage(c.req.path, general);
  await applied(general, language, async () => {
    await next();
  });
  if (!c.res.headers.has("content-language")) c.header("content-language", language);
};

/** Paths of uploads: a receipt and the multipart overhead. */
export function isUploadPath(path: string): boolean {
  return /\/uploads\/?$/.test(path);
}

/** The Appearance settings, which take a favicon. */
export const APPEARANCE_PATH = "/api/v1/admin/settings/appearance";

/** A body larger than its limit, found while it is read (413 request_too_large). */
export class BodyTooLarge extends HTTPException {
  constructor() {
    super(413, { message: t("The file or request is too large.") });
    this.name = "BodyTooLarge";
  }
}

/**
 * Whether reading a body failed because it was too large: the same 413
 * answer for every reader, whether the client declared the length or not.
 */
export function isBodyTooLarge(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof BodyTooLarge) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Passes a body through while counting it; more than `maxSize` bytes fail the read with BodyTooLarge. */
function counted(body: ReadableStream<Uint8Array>, maxSize: number): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxSize) controller.error(new BodyTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Request size limits (the Django version's RequestLimitsMiddleware): an
 * upload may carry one receipt (MAX_RECEIPT_BYTES) and its form, the
 * Appearance settings a favicon, everything else MAX_REQUEST_BODY_BYTES.
 * Checked on the declared length, and on the bytes as the handler reads them:
 * nothing here reads or buffers a body, so the API's origin check and the
 * upload slots come first.
 */
export const requestLimits: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  const maxSize = isUploadPath(path)
    ? config().MAX_RECEIPT_BYTES + 128_000
    : path.startsWith(APPEARANCE_PATH)
      ? 1_000_000
      : config().MAX_REQUEST_BODY_BYTES;
  const declared = c.req.header("content-length");
  if (declared !== undefined && !/^\d+$/.test(declared)) throw badRequest(t("Invalid request."));
  if (declared !== undefined && Number(declared) > maxSize) throw new BodyTooLarge();
  const body = c.req.raw.body;
  if (body && (declared === undefined || c.req.raw.headers.has("transfer-encoding"))) {
    c.req.raw = new Request(c.req.raw, { body: counted(body, maxSize), duplex: "half" } as RequestInit);
  }
  return next();
};

/** Tests only: replaces how a request finds its signed-in user. */
export const authentication: { resolve: (c: Context<AppEnv>) => Promise<User | null> } = {
  resolve: async (c) => (await currentSession(c))?.user ?? null,
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", await authentication.resolve(c));
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request protection for the browser (the Django version's CSRF
 * check): changes need an Origin of the application itself, or one of
 * CSRF_TRUSTED_ORIGINS. The MailerSend
 * webhook is exempt; it proves itself with its signature.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin ? !originAllowed(origin, config()) : c.req.header("sec-fetch-site") !== "same-origin") {
    throw new AppError(403, "forbidden", "Cross-site request rejected");
  }
  await next();
};

/** The signed-in user (401 without one). */
export function requireUser(c: Context<AppEnv>): User {
  const user = c.get("user");
  if (!user || !user.isActive) throw unauthorized();
  return user;
}

/** A signed-in template admin or form editor (the admin area); 403 for anyone else. */
export async function requireEditor(c: Context<AppEnv>): Promise<User> {
  const user = requireUser(c);
  if (!(await isFormEditor(user)))
    throw new AppError(403, "forbidden", "You do not have access to the admin area.");
  return user;
}

/** A signed-in template admin; 403 for anyone else. */
export async function requireTemplateAdmin(c: Context<AppEnv>): Promise<User> {
  const user = requireUser(c);
  if (!(await isTemplateAdmin(user)))
    throw new AppError(403, "forbidden", "Only template admins may do this.");
  return user;
}

/** The JSON body validated with a schema. */
export async function jsonBody<T extends z.ZodType, E extends Env>(
  c: Context<E>,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    if (isBodyTooLarge(error)) throw new BodyTooLarge();
    throw badRequest("The request body must be JSON");
  }
  return parseWith(schema, body);
}

export function queryOf<T extends z.ZodType, E extends Env>(c: Context<E>, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

/** A route parameter that must be a positive integer ID (404 otherwise, like an unknown one). */
export function idParam<E extends Env>(c: Context<E>, name = "id"): number {
  const value = c.req.param(name) ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new AppError(404, "not_found", "Not found");
  return Number(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route parameter that must be a UUID (404 otherwise, like an unknown one). */
export function uuidParam<E extends Env>(c: Context<E>, name = "id"): string {
  const value = c.req.param(name) ?? "";
  if (!UUID.test(value)) throw new AppError(404, "not_found", "Not found");
  return value.toLowerCase();
}
