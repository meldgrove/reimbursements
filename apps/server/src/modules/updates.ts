import { Hono, type Context } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { BodyTooLarge, isBodyTooLarge } from "../http/middleware";
import { isTemplateAdmin } from "../auth/roles";
import { logger } from "../logger";

/**
 * The update button's routes and the Updates page (docs/updates.md): the
 * status, a check, an installation and the channel, through the Meldgrove
 * Updater. `@meldgrove/ui` asks the updater and answers; this module decides
 * who may ask. Only template admins use them; everyone else gets 404, marked
 * `signedOut`, so the button stops its automatic requests when the session
 * ends. The API's origin check guards the POSTs.
 */
const router = new Hono<AppEnv>();

const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

const SIGNED_OUT = { error: "Sign in as a template admin to manage updates.", signedOut: true };

router.use("/admin/updates", adminsOnly);
router.use("/admin/updates/*", adminsOnly);

async function adminsOnly(c: Context<AppEnv>, next: () => Promise<void>) {
  if (!(await isTemplateAdmin(c.get("user")))) return c.json(SIGNED_OUT, 404);
  await next();
}

/**
 * The request with its body read here: a body over the size limit is the
 * app's 413, as on every route, where the handler would take it for no body.
 */
async function withBody(c: Context<AppEnv>): Promise<Request> {
  let body = "";
  try {
    body = await c.req.text();
  } catch (error) {
    if (isBodyTooLarge(error)) throw new BodyTooLarge();
  }
  return new Request(c.req.url, { method: "POST", body });
}

/** The handler's answer through Hono, which keeps the headers middleware set before the route (`x-request-id`). */
async function answer(c: Context<AppEnv>, pending: Promise<Response>) {
  const response = await pending;
  return c.newResponse(response.body, response);
}

router.get("/admin/updates", (c) => answer(c, updates.respond("status")));
router.post("/admin/updates/check", (c) => answer(c, updates.respond("check")));
router.post("/admin/updates/install", async (c) => answer(c, updates.respond("install", await withBody(c))));
router.post("/admin/updates/channel", async (c) => answer(c, updates.respond("channel", await withBody(c))));

export default router;
