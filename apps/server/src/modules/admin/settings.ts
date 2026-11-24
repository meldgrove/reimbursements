import { Hono, type Context } from "hono";
import type { AppEnv } from "../../http/env";
import { badRequest } from "../../http/errors";
import { BodyTooLarge, isBodyTooLarge, requireTemplateAdmin } from "../../http/middleware";
import { loadSettings } from "../../services/app-settings";
import {
  appearanceFromJson,
  appearancePage,
  generalPage,
  saveAppearance,
  saveGeneral,
  type AppearanceInput,
} from "../../services/general-settings";
import { adminActor } from "../../services/settings-audit";
import { actor, body } from "./common";

/**
 * The Admin group's General and Appearance pages (AppSettingsAdmin and
 * AppearanceAdmin of portal/admin.py), for template admins: the app
 * language, timezone, date and number format, the operator and legal page,
 * the running version; the accent color and the favicon. Both are parts of
 * the one settings row. The checks are in services/general-settings.ts,
 * which `cli settings` uses too.
 */
const router = new Hono<AppEnv>();

router.get("/admin/settings/general", async (c) => {
  await requireTemplateAdmin(c);
  return c.json(generalPage(await loadSettings()));
});

router.put("/admin/settings/general", async (c) => {
  const user = await requireTemplateAdmin(c);
  const saved = await saveGeneral(await body(c), adminActor(actor(user), "General"));
  return c.json({ ...generalPage(saved), message: "The general settings were saved." });
});

router.get("/admin/settings/appearance", async (c) => {
  await requireTemplateAdmin(c);
  return c.json(appearancePage(await loadSettings()));
});

/** The Appearance form: JSON, or multipart with the new favicon as `favicon`. */
async function appearanceInput(c: Context<AppEnv>): Promise<AppearanceInput> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch (error) {
      if (isBodyTooLarge(error)) throw new BodyTooLarge();
      throw badRequest("The upload could not be read.");
    }
    const file = form.favicon;
    return {
      accentColor: typeof form.accentColor === "string" ? form.accentColor : "",
      removeFavicon: form.removeFavicon === "true" || form.removeFavicon === "on",
      favicon: file instanceof File && file.size > 0 ? file : null,
    };
  }
  return appearanceFromJson(await body(c));
}

router.post("/admin/settings/appearance", async (c) => {
  const user = await requireTemplateAdmin(c);
  const page = await saveAppearance(await appearanceInput(c), adminActor(actor(user), "Appearance"));
  return c.json({ ...page, message: "The appearance settings were saved." });
});

export default router;
