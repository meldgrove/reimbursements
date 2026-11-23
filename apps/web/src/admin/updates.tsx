import type { ReactNode } from "react";
import { UpdatesProvider } from "@meldgrove/ui/updates";
import { APP_NAME } from "@reimbursements/shared/constants";
import { useIsTemplateAdmin, useMeta } from "@/lib/meta";
import { apiUrl } from "@/lib/api";

/** The deployment guide of the released version, for admins without an update service. */
const UPDATES_GUIDE = "https://github.com/meldgrove/reimbursements/blob/stable/docs/updates.md";

/** The locale whose dates read like each date format (Admin > General); en-GB for YYYY-MM-DD. */
const DATE_LOCALES: Record<string, string> = { "d.m.Y": "de-DE", "d/m/Y": "en-GB", "m/d/Y": "en-US" };

/**
 * Template admins: the update status that the header button and the Updates
 * page share (polling, installing, following the restart). Everyone else gets
 * 404 from the routes, so nothing asks for them.
 */
export function AdminUpdates({ children }: { children: ReactNode }) {
  const { settings } = useMeta();
  if (!useIsTemplateAdmin()) return children;
  return (
    <UpdatesProvider
      appName={APP_NAME}
      project="reimbursements"
      url={apiUrl("/admin/updates")}
      guideUrl={UPDATES_GUIDE}
      // Dates as in the rest of the admin area: the format and timezone of Admin > General.
      dateLocale={DATE_LOCALES[settings.dateFormat] ?? "en-GB"}
      timeZone={settings.timezone}
    >
      {children}
    </UpdatesProvider>
  );
}
