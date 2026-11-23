import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Badge } from "@meldgrove/ui/badge";
import { LoadingState } from "@meldgrove/ui/states";
import { APP_NAME } from "@reimbursements/shared/constants";
import type { StartAnswer } from "@reimbursements/shared/api/public";
import { api } from "@/lib/api";
import { useT } from "@/i18n";
import { usePageTitle } from "@/routes/participant";

/**
 * The start page (portal/templates/portal/index.html): it sends participants to
 * the primary form while that form takes claims, and lists no forms.
 */
export function StartPage() {
  const t = useT();
  const navigate = useNavigate();
  usePageTitle(t("Submit expenses"));
  const query = useQuery({
    queryKey: ["public-start"],
    queryFn: ({ signal }) => api.get<StartAnswer>("/public/start", undefined, signal),
    staleTime: 0,
  });
  const redirect = query.data?.redirect;
  useEffect(() => {
    if (redirect) void navigate({ to: "/f/$slug", params: { slug: redirect }, replace: true });
  }, [redirect, navigate]);
  if (query.isPending || redirect) return <LoadingState />;
  return (
    <div className="flex flex-col items-start gap-4 py-8">
      <Badge variant="outline">{APP_NAME}</Badge>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("Submit expenses")}</h1>
      <p className="text-muted-foreground max-w-2xl text-lg">
        {t(
          "Here you can claim reimbursement of costs you paid out of your own pocket. Please open the link to your form that you received from your team.",
        )}
      </p>
    </div>
  );
}
