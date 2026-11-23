import type { GeneralSettings } from "@reimbursements/shared/api/meta";
import type { User } from "../db/schema";

/** Variables every request carries (Hono context). */
export type AppEnv = {
  Variables: {
    requestId: string;
    /** The signed-in admin user; null for anonymous requests. Set by the `authenticate` middleware. */
    user: User | null;
    /** The General settings this request runs in (`applySettings`); unset on health checks. */
    settings: GeneralSettings;
    /** A stricter Content-Security-Policy of one response (the favicon's), over the app's. */
    contentSecurityPolicy?: string;
  };
};
