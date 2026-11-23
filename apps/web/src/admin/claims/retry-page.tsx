import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Card } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { Label } from "@meldgrove/ui/label";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Textarea } from "@meldgrove/ui/textarea";
import { api, ApiError, errorMessage } from "@/lib/api";
import { retryRoute } from "../routes";
import { retryQuery } from "../api";
import { DetailList, FormRow, ToneBadge, fieldErrors, useRecordName } from "../parts";

/**
 * Process a claim again (template admins): says what a retry would do before
 * it runs, asks for a reason, and for a resend that may duplicate, the
 * acknowledgment that Finance may receive the claim twice.
 */
export function RetryPage() {
  const { claimId } = retryRoute.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(retryQuery(claimId));
  const [reason, setReason] = useState("");
  /** The claim and plan the acknowledgment was given for: another claim or a changed plan needs its own. */
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const reference = query.data?.claim.reference;
  const planKey = query.data?.plan?.duplicateRisk ? `${claimId}:${JSON.stringify(query.data.plan)}` : null;
  const acknowledged = planKey !== null && acknowledgedFor === planKey;
  useRecordName(
    pathname,
    reference ? (reference.length > 12 ? `${reference.slice(0, 11)}…` : reference) : null,
  );
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { claim, plan, refused } = query.data;

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblem("");
    try {
      const answer = await api.post<{ message: string }>(`/admin/claims/${claimId}/retry`, {
        reason,
        acknowledgeDuplicateRisk: acknowledged,
      });
      toast.success(answer.message);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await navigate({ to: "/admin/claims/$claimId", params: { claimId } });
    } catch (error) {
      setErrors(fieldErrors(error));
      if (!(error instanceof ApiError && error.status === 422)) setProblem(errorMessage(error));
      // The claim changed meanwhile (a delivery became uncertain, for example):
      // show the plan as it is now, with the reason kept.
      if (error instanceof ApiError && error.status === 409) await query.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="Process claim again"
        description={
          plan?.action === "render"
            ? "The PDF is created again."
            : plan?.action === "resend"
              ? "The PDF is sent to the receiving inbox again."
              : "A failed PDF creation starts again. A created PDF is sent to the receiving inbox again."
        }
      />
      <Card className="gap-0 py-0">
        <DetailList
          rows={[
            ["Reference", <span className="font-medium break-all">{claim.reference}</span>],
            ["Form", claim.form],
            ["Current status", <ToneBadge tone={claim.status.tone}>{claim.status.label}</ToneBadge>],
          ]}
        />
      </Card>
      {refused ? (
        <>
          <Alert>
            <CircleAlert />
            <AlertTitle>Not possible right now</AlertTitle>
            <AlertDescription>{refused}</AlertDescription>
          </Alert>
          <div>
            <Button variant="outline" asChild>
              <Link to="/admin/claims/$claimId" params={{ claimId }}>
                Back to the claim
              </Link>
            </Button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {plan?.duplicateRisk ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Duplicate delivery possible</AlertTitle>
              <AlertDescription>
                An earlier delivery did not clearly fail. Check with the email service or with Finance whether
                the email arrived before you send it again.
              </AlertDescription>
            </Alert>
          ) : null}
          {problem ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <FormRow label="Reason" required help="Logged with your name on the claim." error={errors.reason}>
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </FormRow>
          {plan?.duplicateRisk ? (
            <div className="flex items-start gap-3">
              <Checkbox
                id="acknowledge-duplicate-risk"
                checked={acknowledged}
                onCheckedChange={(value) => setAcknowledgedFor(value === true ? planKey : null)}
              />
              <Label htmlFor="acknowledge-duplicate-risk" className="leading-snug font-normal">
                I have checked the delivery and accept that Finance may receive the claim twice.
              </Label>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              <RefreshCw />
              Process again
            </Button>
            <Button variant="outline" asChild>
              <Link to="/admin/claims/$claimId" params={{ claimId }}>
                Cancel
              </Link>
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}
