import { z } from "zod";

/*
 * In-app updates (admins only): the app passes the Meldgrove Updater's API
 * through `/admin/updates`. The updater's Status and Update are its contract
 * (https://github.com/meldgrove/updater#the-apps-update-button); change both
 * sides together.
 */

/** A version the updater may install: a release, a preview, or an image digest. */
export const UPDATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?$/;
export const UPDATE_DIGEST = /^sha256:[0-9a-f]{12}$/;

export const updateChannelSchema = z.enum(["stable", "preview"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const updateSchema = z.object({
  /** A version, or "sha256:<12 hex>" for an image without one. */
  version: z.string(),
  preview: z.boolean(),
  publishedAt: z.string().nullable(),
  /** Release notes, or the compare view of a preview. */
  url: z.string().nullable(),
  /** Change titles, newest release first, at most 15. */
  notes: z.array(z.string()),
  /** All changes, when more than notes. */
  changes: z.number(),
  /** When it installs automatically; null: not automatically. */
  installsAt: z.string().nullable(),
  /** The message of an earlier failed installation. */
  failed: z.string().nullable(),
});
export type Update = z.infer<typeof updateSchema>;

export const installStageSchema = z.enum(["requested", "pulling", "starting", "rolling-back", "deploying"]);
export type InstallStage = z.infer<typeof installStageSchema>;

export const updaterStatusSchema = z.object({
  updater: z.string(),
  mode: z.enum(["host", "platform", "off"]),
  channel: updateChannelSchema,
  /** Why admins cannot switch the channel; null: they can. */
  channelLocked: z.string().nullable(),
  installed: z.string().nullable(),
  available: updateSchema.nullable(),
  /** Needs upgrade steps; Stable only. */
  attention: updateSchema.nullable(),
  installing: z
    .object({
      version: z.string(),
      startedAt: z.string(),
      manual: z.boolean(),
      stage: installStageSchema,
    })
    .nullable(),
  last: z
    .object({
      version: z.string(),
      result: z.enum(["installed", "failed", "rolled-back", "accepted"]),
      message: z.string().nullable(),
      finishedAt: z.string(),
    })
    .nullable(),
  checking: z.boolean(),
  /** The last successful check. */
  checkedAt: z.string().nullable(),
  /** The last check's error. */
  error: z.string().nullable(),
  automatic: z.boolean(),
  /** e.g. "3d"; null: none. */
  cooldown: z.string().nullable(),
  /** e.g. "02:00-05:00". */
  window: z.string().nullable(),
  timezone: z.string(),
});
export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;

/** The answer of every `/admin/updates` route (also of a 409). */
export const updatesResponseSchema = z.object({
  /** APP_VERSION; null in development. */
  app: z.object({ version: z.string().nullable() }),
  /** false: no updater at UPDATER_URL. */
  reachable: z.boolean(),
  updater: updaterStatusSchema.nullable(),
  /** Why the updater refused or could not be reached. */
  error: z.string().nullable(),
});
export type UpdatesResponse = z.infer<typeof updatesResponseSchema>;

export const updateInstallSchema = z.object({
  version: z
    .string()
    .refine((value) => UPDATE_VERSION.test(value) || UPDATE_DIGEST.test(value), "Not a version"),
});
export type UpdateInstall = z.infer<typeof updateInstallSchema>;

export const updateChannelInputSchema = z.object({ channel: updateChannelSchema });
export type UpdateChannelInput = z.infer<typeof updateChannelInputSchema>;
