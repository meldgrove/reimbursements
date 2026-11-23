import type { Hono } from "hono";
import type { AppEnv } from "../http/env";
import admin from "./admin";
import meta from "./meta";
import publicApi from "./public";
import updates from "./updates";
import webhooks from "./webhooks";

/**
 * Routers mounted under /api/v1 (they see the signed-in user as
 * `c.get("user")`; changes need the app's own origin). Each module adds one
 * line here: participant routes under /public/…, admin routes under /admin/….
 */
export const API_MODULES: Hono<AppEnv>[] = [meta, updates, admin, publicApi];

/**
 * Routers mounted at the root, outside the API's same-origin check, for
 * requests that prove themselves (the MailerSend webhook at
 * /webhooks/mailersend/).
 */
export const ROOT_MODULES: Hono<AppEnv>[] = [webhooks];
