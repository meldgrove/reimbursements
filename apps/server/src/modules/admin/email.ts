import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../http/env";
import { jsonBody, requireTemplateAdmin } from "../../http/middleware";
import * as emailConnection from "../../services/email-connection";
import { emailPage, saveEmail, testEmail } from "../../services/email-settings";
import { adminActor } from "../../services/settings-audit";
import { actor, body } from "./common";

/**
 * Admin > Email (EmailSettingsAdmin of portal/admin.py and portal/admin_email.py of the
 * Django version), for template admins: the provider that sends email, its credentials,
 * the participant confirmation, and a test email. The checks are in
 * services/email-settings.ts, which `cli settings` uses too.
 */
const router = new Hono<AppEnv>();

router.get("/admin/settings/email", async (c) => {
  const user = await requireTemplateAdmin(c);
  return c.json(await emailPage(await emailConnection.loadEmailSettings(), user.email));
});

router.put("/admin/settings/email", async (c) => {
  const user = await requireTemplateAdmin(c);
  const row = await saveEmail(await jsonBody(c, z.unknown()), adminActor(actor(user), "Email"));
  return c.json({ ...(await emailPage(row, user.email)), message: "The email settings were saved." });
});

router.post("/admin/settings/email/test", async (c) => {
  await requireTemplateAdmin(c);
  const input = await body(c);
  return c.json(await testEmail(input.to));
});

/** Only POST sends a test email (Django answered 405). */
router.get("/admin/settings/email/test", (c: Context<AppEnv>) =>
  c.json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405),
);

export default router;
