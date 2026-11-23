import { Hono, type Context } from "hono";
import { updateChannelInputSchema, updateInstallSchema } from "@reimbursements/shared/api/updates";
import type { AppEnv } from "../http/env";
import { isTemplateAdmin } from "../auth/roles";
import { parseWith } from "../http/errors";
import { askUpdater, type UpdatesAnswer } from "../updates/updater";

/**
 * The update button's routes and the Updates page (portal/admin_updates.py of
 * the Django version, docs/updates.md): the status, a check, an installation
 * and the channel, through the Meldgrove Updater. Only template admins use
 * them; everyone else gets 404, marked `signedOut`, so the button stops its
 * automatic requests when the session ends.
 */
const router = new Hono<AppEnv>();

const SIGNED_OUT = { error: "Sign in as a template admin to manage updates.", signedOut: true };

const answer = (c: Context<AppEnv>, result: UpdatesAnswer) => c.json(result.body, result.status);

router.use("/admin/updates", adminsOnly);
router.use("/admin/updates/*", adminsOnly);

async function adminsOnly(c: Context<AppEnv>, next: () => Promise<void>) {
  if (!(await isTemplateAdmin(c.get("user")))) return c.json(SIGNED_OUT, 404);
  await next();
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

router.get("/admin/updates", async (c) => answer(c, await askUpdater({ call: "status" })));

router.post("/admin/updates/check", async (c) => answer(c, await askUpdater({ call: "check" })));

router.post("/admin/updates/install", async (c) => {
  const { version } = parseWith(updateInstallSchema, await body(c));
  return answer(c, await askUpdater({ call: "install", version }));
});

router.post("/admin/updates/channel", async (c) => {
  const { channel } = parseWith(updateChannelInputSchema, await body(c));
  const result = await askUpdater({ call: "channel", channel });
  // Saved only when the updater's status names the chosen channel (as in the Django version).
  if (
    result.status < 300 &&
    result.body.reachable &&
    !result.body.error &&
    result.body.updater?.channel !== channel
  ) {
    return answer(c, {
      status: 409,
      body: { ...result.body, error: "The update service did not switch the channel." },
    });
  }
  return answer(c, result);
});

export default router;
