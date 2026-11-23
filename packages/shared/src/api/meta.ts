import { z } from "zod";
import type { DateFormatCode } from "../dates";
import type { Language } from "../i18n";
import type { NumberFormatCode } from "../numbers";
import type { RoleName } from "../constants";

/** The General and Appearance settings every page needs (not the favicon image). */
export type GeneralSettings = {
  language: Language;
  timezone: string;
  dateFormat: DateFormatCode;
  numberFormat: NumberFormatCode;
  /** #rrggbb, or "" for the shared colors. */
  accentColor: string;
  /** Names the favicon in its link (/favicon/<digest>/); "" for the standard one. */
  faviconDigest: string;
  faviconType: string;
};

/** The signed-in person of the admin area. */
export type MeUser = {
  id: number;
  name: string;
  email: string;
  roles: RoleName[];
  isTemplateAdmin: boolean;
  isFormEditor: boolean;
};

/** GET /api/v1/meta: what every page of both areas needs. Answered without a session too. */
export type Meta = {
  appName: string;
  /** The release version; "" for images built from source. */
  version: string;
  settings: GeneralSettings;
  /** PORTAL_OPERATOR and PORTAL_LEGAL_URL: the footer of public pages. */
  operator: string;
  legalUrl: string;
  /** The signed-in person, or null. */
  user: MeUser | null;
  /** Template admins see the update button; false without an updater. */
  updatesButton: boolean;
  /** The sign-in provider's account page for the person's own settings ("" when unknown). */
  accountUrl: string;
  auth: {
    oidcEnabled: boolean;
    providerName: string;
    /** Development only: sign in without a provider. */
    devLogin: boolean;
  };
};

export const devLoginSchema = z.object({ username: z.string().min(1).max(150) });
export type DevLoginInput = z.infer<typeof devLoginSchema>;
