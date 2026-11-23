import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import type { PrivacyNoticeRow } from "@reimbursements/shared/api/admin";
import { privacyNotices } from "../../db/schema";
import { atomic, isUniqueViolation, q } from "../../db/tx";
import type { AppEnv } from "../../http/env";
import { notFound, validationError } from "../../http/errors";
import { idParam, requireTemplateAdmin } from "../../http/middleware";
import { formatDateTime } from "../../i18n";
import { currentPrivacyNotice } from "../../models";
import { actor, body } from "./common";

/**
 * The privacy notice (PrivacyNoticeAdmin of portal/admin.py), for template
 * admins: participants always see the latest version, and every change is
 * saved as a new version. Versions are never changed or deleted; claims keep
 * the version their participant acknowledged.
 */
const router = new Hono<AppEnv>();

router.get("/admin/privacy-notices", async (c) => {
  await requireTemplateAdmin(c);
  const rows = await q().select().from(privacyNotices).orderBy(desc(privacyNotices.version));
  const current = rows[0]?.id;
  return c.json(
    rows.map((row): PrivacyNoticeRow => ({
      id: row.id,
      version: row.version,
      createdAt: formatDateTime(row.createdAt),
      createdBy: row.createdBy,
      current: row.id === current,
    })),
  );
});

/** A new version starts from the current text. */
router.get("/admin/privacy-notices/new", async (c) => {
  await requireTemplateAdmin(c);
  return c.json({ text: (await currentPrivacyNotice())?.text ?? "" });
});

router.get("/admin/privacy-notices/:id", async (c) => {
  await requireTemplateAdmin(c);
  const [row] = await q()
    .select()
    .from(privacyNotices)
    .where(eq(privacyNotices.id, idParam(c)));
  if (!row) throw notFound("No privacy notice has this ID.");
  const current = await currentPrivacyNotice();
  return c.json({
    id: row.id,
    version: row.version,
    text: row.text,
    createdAt: formatDateTime(row.createdAt),
    createdBy: row.createdBy,
    current: row.id === current?.id,
  });
});

/** Saves a new version: the next number, by whoever wrote it. */
router.post("/admin/privacy-notices", async (c) => {
  const user = await requireTemplateAdmin(c);
  const text = (await body(c)).text;
  if (typeof text !== "string" || !text.trim()) throw validationError({ text: "This field is required." });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [created] = await atomic(() =>
        q()
          .insert(privacyNotices)
          .values({
            version: sql`(select coalesce(max(${privacyNotices.version}), 0) + 1 from ${privacyNotices})`,
            text: text.trim(),
            createdBy: actor(user),
          })
          .returning(),
      );
      return c.json({ id: created!.id, version: created!.version }, 201);
    } catch (error) {
      // Two admins saving at once: the second takes the next number.
      if (!isUniqueViolation(error) || attempt >= 2) throw error;
    }
  }
});

export default router;
