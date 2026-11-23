import { Hono } from "hono";
import type { AppEnv } from "../../http/env";
import claims from "./claims";
import forms from "./forms";
import privacy from "./privacy";
import search from "./search";
import settings from "./settings";
import templates from "./templates";

/**
 * The admin area's API under /api/v1/admin (portal/admin.py of the Django
 * version): claims, forms, templates, the privacy notice, the General and
 * Appearance settings and the search. Updates are in modules/updates.ts.
 * Every route checks the person's role and their access to the record.
 */
const admin = new Hono<AppEnv>();
for (const router of [claims, forms, templates, privacy, settings, search]) admin.route("/", router);

export default admin;
