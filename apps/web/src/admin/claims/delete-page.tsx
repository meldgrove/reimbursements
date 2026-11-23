import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Textarea } from "@meldgrove/ui/textarea";
import type { DeleteAnswer } from "@reimbursements/shared/api/admin";
import { api, ApiError, errorMessage } from "@/lib/api";
import { deleteClaimsRoute } from "../routes";
import { deletionQuery } from "../api";
import { FormRow, fieldErrors } from "../parts";
import { ClaimSummaries } from "./claim-summaries";

/**
 * Delete claims for good (template admins): one from its page, or the claims
 * selected in the list. Says whether Finance may already hold them, and asks
 * for a reason that is logged.
 */
export function DeleteClaimsPage() {
  const search = deleteClaimsRoute.useSearch();
  const ids = (search.ids ?? "").split(",").filter(Boolean);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(deletionQuery(ids));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;
  const rows = query.data.rows;
  const sent = rows.filter((row) => row.sent).length;
  const unsent = rows.length - sent;
  const single = rows.length === 1;
  const back = single ? `/admin/claims/${rows[0]!.id}` : "/admin/claims";

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblems([]);
    try {
      const answer = await api.post<DeleteAnswer>("/admin/claims/delete", {
        ids: rows.map((row) => row.id),
        reason,
      });
      report(answer);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await navigate({ to: "/admin/claims" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const answer = error.body as DeleteAnswer;
        setProblems(
          answer.messages.filter((message) => message.tone === "error").map((message) => message.text),
        );
      } else {
        setErrors(fieldErrors(error));
        if (!(error instanceof ApiError && error.status === 422)) setProblems([errorMessage(error)]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title={single ? "Delete claim?" : `Delete ${rows.length} claims?`}
        description="The claim is deleted at once and for good, with its name, address, bank details, expenses, receipts, signature and PDF, and no longer appears in the list. This cannot be undone."
      />
      <ClaimSummaries claims={rows} label="Claims to delete" />
      {sent ? (
        <Alert>
          <TriangleAlert />
          <AlertTitle>
            {single
              ? "Already sent to Finance"
              : `${sent} ${sent === 1 ? "claim was" : "claims were"} already sent to Finance`}
          </AlertTitle>
          <AlertDescription>
            Deleting does not remove the PDF from Finance's inbox or from downstream systems.
          </AlertDescription>
        </Alert>
      ) : null}
      {unsent ? (
        <Alert>
          <Info />
          <AlertTitle>
            {single
              ? "Not yet sent to Finance"
              : `${unsent} ${unsent === 1 ? "claim was" : "claims were"} not yet sent to Finance`}
          </AlertTitle>
          <AlertDescription>
            Once deleted, {unsent === 1 ? "it is" : "they are"} no longer processed or sent.
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {problems.length ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              {problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}
        <FormRow
          label="Reason"
          required
          help="Logged with your name. Do not include names, bank details or receipt details."
          error={errors.reason}
        >
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
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="destructive" disabled={busy}>
            <Trash2 />
            {single ? "Delete claim for good" : `Delete ${rows.length} claims for good`}
          </Button>
          <Button variant="outline" asChild>
            <Link to={back}>Cancel</Link>
          </Button>
        </div>
      </form>
    </Page>
  );
}

/** The outcome of a deletion as messages. */
function report(answer: DeleteAnswer) {
  for (const message of answer.messages) {
    if (message.tone === "success") toast.success(message.text);
    else if (message.tone === "warning") toast.warning(message.text);
    else toast.error(message.text);
  }
}
