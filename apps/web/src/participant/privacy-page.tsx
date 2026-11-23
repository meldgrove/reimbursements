import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@meldgrove/ui/states";
import type { PrivacyAnswer } from "@reimbursements/shared/api/public";
import { api } from "@/lib/api";
import { useT } from "@/i18n";
import { usePageTitle } from "@/routes/participant";
import { Paragraphs } from "./parts";

/** The current privacy notice (portal/templates/portal/privacy.html). */
export function PrivacyPage() {
  const t = useT();
  usePageTitle(t("Privacy"));
  const query = useQuery({
    queryKey: ["public-privacy"],
    queryFn: ({ signal }) => api.get<PrivacyAnswer>("/public/privacy", undefined, signal),
  });
  if (query.isPending) return <LoadingState />;
  const notice = query.data?.notice;
  return (
    <article className="bg-card text-card-foreground rounded-xl border p-6 shadow-sm sm:p-10">
      {notice ? (
        <>
          <Paragraphs text={notice.text} className="prose-notice leading-relaxed [&_h3]:text-lg" />
          <p className="text-muted-foreground mt-8 border-t pt-4 text-sm">
            {t("Version {version} of {date}", { version: notice.version, date: notice.date })}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Privacy")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("The privacy notice is unavailable at the moment.")}
          </p>
        </>
      )}
    </article>
  );
}
