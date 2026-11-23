import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createRoute, Link, Outlet } from "@tanstack/react-router";
import { UIProvider } from "@meldgrove/ui/i18n";
import { APP_NAME } from "@reimbursements/shared/constants";
import { LanguageContext, useT } from "@/i18n";
import { useMeta } from "@/lib/meta";
import { rootRoute } from "./root";

/**
 * The frame of the participant pages (the Django version's portal/base.html):
 * no header and no sign-in, a skip link, the page, and a footer with the
 * operator, the legal notice, the privacy notice and, on a form, its contact
 * for questions. Texts follow the app language of the General settings.
 */

type Footer = { supportEmail: string | null; setSupportEmail: (email: string | null) => void };
const FooterContext = createContext<Footer>({ supportEmail: null, setSupportEmail: () => undefined });

/** A form page names its contact for questions in the footer while it shows. */
export function useSupportEmail(email: string | null | undefined) {
  const { setSupportEmail } = useContext(FooterContext);
  useEffect(() => {
    setSupportEmail(email ?? null);
    return () => setSupportEmail(null);
  }, [email, setSupportEmail]);
}

/** The page's title in the browser tab: "<title> · Meldgrove Reimbursement". */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}

function ParticipantFooter({ supportEmail }: { supportEmail: string | null }) {
  const t = useT();
  const meta = useMeta();
  const [before, after] = t("Questions about your reimbursement? {email}", { email: "\u0000" }).split(
    "\u0000",
  );
  return (
    <footer className="bg-background border-t">
      <div className="text-muted-foreground mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm sm:px-6">
        {meta.operator ? <span>{meta.operator}</span> : null}
        {meta.legalUrl ? (
          <a className="hover:text-foreground hover:underline" href={meta.legalUrl}>
            {t("Legal notice")}
          </a>
        ) : null}
        <Link className="hover:text-foreground hover:underline" to="/datenschutz">
          {t("Privacy")}
        </Link>
        {supportEmail ? (
          <span>
            {before}
            <a className="text-foreground font-medium hover:underline" href={`mailto:${supportEmail}`}>
              {supportEmail}
            </a>
            {after}
          </span>
        ) : null}
      </div>
    </footer>
  );
}

export function ParticipantFrame({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const language = meta.settings.language;
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return (
    <LanguageContext.Provider value={language}>
      <UIProvider locale={language}>
        <FooterContext.Provider value={{ supportEmail, setSupportEmail }}>
          <div className="bg-muted/40 flex min-h-dvh flex-col">
            <SkipLink />
            <main
              id="main"
              className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12"
            >
              {children}
            </main>
            <ParticipantFooter supportEmail={supportEmail} />
          </div>
        </FooterContext.Provider>
      </UIProvider>
    </LanguageContext.Provider>
  );
}

function SkipLink() {
  const t = useT();
  return (
    <a
      className="bg-background sr-only z-50 rounded-md px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      href="#main"
    >
      {t("Skip to content")}
    </a>
  );
}

/** The participant pages' layout route; their routes (participant/routes.tsx) are its children. */
export const participantRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "participant",
  component: () => (
    <ParticipantFrame>
      <Outlet />
    </ParticipantFrame>
  ),
});
