import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { Badge } from "@meldgrove/ui/badge";
import { LoadingState } from "@meldgrove/ui/states";
import { PAYMENT_TIMING } from "@reimbursements/shared/constants";
import type { ReceivedAnswer } from "@reimbursements/shared/api/public";
import { useT } from "@/i18n";
import { usePageTitle, useSupportEmail } from "@/routes/participant";
import { ClosedPage } from "./closed-page";
import { Steps } from "./parts";
import { receivedRoute } from "./routes";

type Loaded = { found: true; claim: ReceivedAnswer } | { found: false };

async function loadReceived(claimId: string, signal?: AbortSignal): Promise<Loaded> {
  const response = await fetch(`/api/v1/public/received/${encodeURIComponent(claimId)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new Error("status_unavailable");
  return { found: true, claim: (await response.json()) as ReceivedAnswer };
}

/**
 * The confirmation after submitting (portal/templates/portal/received.html and
 * received.js): the reference, and the claim's outcome (processing, problem
 * or delivered), checked again with growing pauses until it is final.
 */
export function ReceivedPage() {
  const { claimId } = receivedRoute.useParams();
  const t = useT();
  usePageTitle(t("Claim submitted"));
  const query = useQuery({
    queryKey: ["public-received", claimId],
    queryFn: () => loadReceived(claimId),
    // The page checks the status itself (below); the query only loads it once.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const claim = query.data?.found ? query.data.claim : null;
  useSupportEmail(claim?.form.supportEmail);
  if (query.isPending) return <LoadingState />;
  if (query.isError && !query.data)
    return <ClosedPage name={null} message={t("The request could not be processed.")} />;
  if (!claim) return <ClosedPage name={null} message={t("The claim was not found.")} />;
  return <Received claimId={claimId} initial={claim} />;
}

function Received({ claimId, initial }: { claimId: string; initial: ReceivedAnswer }) {
  const t = useT();
  const text = {
    processing: t("Your claim is being processed and sent to Finance."),
    problem: t(
      "There was a problem processing your claim. It stays saved; please do not submit it again, but contact us with your reference.",
    ),
    delivered: t("Your claim was sent to Finance."),
    unavailable: t(
      "The status is unavailable right now. Your claim stays saved; please do not submit it again.",
    ),
    reload: t("Reload this page later to check the current status."),
  };
  const messages: Record<string, string> = { delivered: text.delivered, problem: text.problem };
  const [status, setStatus] = useState(messages[initial.state] ?? text.processing);
  const polls = useRef(0);

  useEffect(() => {
    if (initial.final) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const controller = new AbortController();
    async function refresh() {
      const deadline = setTimeout(() => controller.abort(), 15_000);
      let final = false;
      try {
        const result = await loadReceived(claimId, controller.signal);
        if (!result.found) throw new Error("status_unavailable");
        setStatus(messages[result.claim.state] ?? text.processing);
        final = result.claim.final;
      } catch {
        if (stopped) return;
        setStatus(text.unavailable);
      } finally {
        clearTimeout(deadline);
      }
      if (final || stopped) return;
      polls.current += 1;
      if (polls.current < 120) {
        const delay = document.hidden ? 30_000 : Math.min(30_000, 5000 * 1.1 ** polls.current);
        timer = setTimeout(refresh, delay + Math.random() * 1000);
      } else {
        setStatus((current) => `${current} ${text.reload}`);
      }
    }
    timer = setTimeout(refresh, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
    // The texts follow the language, which does not change on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimId, initial.final]);

  return (
    <>
      <Steps current={3} />
      <section className="bg-card text-card-foreground flex flex-col items-center gap-5 rounded-xl border px-6 py-10 text-center shadow-sm sm:px-10">
        <span
          className="bg-success/10 text-success flex size-14 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          <CircleCheck className="size-7" />
        </span>
        <Badge variant="outline">{initial.form.name}</Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {t("Thank you. Your claim has been submitted.")}
        </h1>
        <p className="text-muted-foreground max-w-lg">
          {t(
            "We have received your details and receipts. This confirmation of receipt is not yet an approval of the reimbursement.",
          )}
        </p>
        <div className="bg-muted/50 flex w-full max-w-md flex-col gap-1 rounded-lg border p-4">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("Your reference")}
          </span>
          <strong id="claim-reference" className="font-mono text-sm break-all select-all">
            {initial.reference}
          </strong>
          <small className="text-muted-foreground text-xs">
            {t("Please note the reference for any questions.")}
          </small>
        </div>
        <p id="processing-status" className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
          {status}
        </p>
        <p className="text-muted-foreground text-sm">{t(PAYMENT_TIMING)}</p>
      </section>
    </>
  );
}
