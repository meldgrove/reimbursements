import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "@meldgrove/ui/states";
import type { ClosedFormPage, FormPage as FormPageAnswer } from "@reimbursements/shared/api/public";
import { useT } from "@/i18n";
import { usePageTitle, useSupportEmail } from "@/routes/participant";
import { ClaimForm } from "./claim-form";
import { ClosedPage } from "./closed-page";
import { formRoute } from "./routes";

type Loaded =
  | { kind: "open"; page: FormPageAnswer }
  | { kind: "closed"; page: ClosedFormPage | null; status: number }
  | { kind: "missing" };

/** The form page: opens the participant's draft (GET /api/v1/public/forms/<slug>). */
async function loadFormPage(slug: string): Promise<Loaded> {
  const response = await fetch(`/api/v1/public/forms/${encodeURIComponent(slug)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return { kind: "missing" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && (body as FormPageAnswer | null)?.state)
    return { kind: "open", page: body as FormPageAnswer };
  if ((body as ClosedFormPage | null)?.state === "closed")
    return { kind: "closed", page: body as ClosedFormPage, status: response.status };
  throw new Error(`The form could not be loaded (${response.status})`);
}

/** A reimbursement form at /f/<slug>/ (portal/templates/portal/form.html and closed.html). */
export function FormPage() {
  const { slug } = formRoute.useParams();
  const t = useT();
  // The form opens the participant's draft: load it once, never again in the background.
  const query = useQuery({
    queryKey: ["public-form", slug],
    queryFn: () => loadFormPage(slug),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const loaded = query.data;
  const title =
    loaded?.kind === "open"
      ? loaded.page.form.name
      : loaded?.kind === "closed"
        ? t("Form closed")
        : t("Submit expenses");
  usePageTitle(title);
  useSupportEmail(
    loaded?.kind === "open"
      ? loaded.page.form.supportEmail
      : loaded?.kind === "closed"
        ? loaded.page?.supportEmail
        : null,
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError && !query.data)
    return <ClosedPage name={null} message={t("The request could not be processed.")} />;
  if (loaded!.kind === "missing") return <ClosedPage name={null} message={t("The form was not found.")} />;
  if (loaded!.kind === "closed")
    return <ClosedPage name={loaded!.page?.name ?? null} message={loaded!.page?.message ?? null} />;
  return <ClaimForm key={loaded!.page.draft?.id ?? "preview"} page={loaded!.page} slug={slug} />;
}
