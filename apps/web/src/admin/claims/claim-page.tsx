import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import type { ArchiveAnswer, ClaimDetail } from "@reimbursements/shared/api/admin";
import { api, errorMessage } from "@/lib/api";
import { claimRoute } from "../routes";
import { claimQuery } from "../api";
import { DetailList, ToneBadge, useRecordName } from "../parts";
import { ArchiveDialog } from "./archive-dialog";

/**
 * A claim (the Django admin's claim page): who submitted it, its status and
 * deletion dates, and the actions operators logged. Template admins process
 * it again, archive and delete it. Bank details and receipts stay out of the
 * admin area: they go to Finance in the PDF.
 */
export function ClaimPage() {
  const { claimId } = claimRoute.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const query = useQuery(claimQuery(claimId));
  useRecordName(pathname, query.data?.reference ? short(query.data.reference) : null);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <Claim claim={query.data} />;
}

/** Long references (a claim ID) cut as Django's breadcrumbs did. */
function short(reference: string) {
  return reference.length > 12 ? `${reference.slice(0, 11)}…` : reference;
}

function Claim({ claim }: { claim: ClaimDetail }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Extract<ArchiveAnswer, { confirm: true }> | null>(null);
  const [busy, setBusy] = useState(false);

  const archive = async (confirmed = false) => {
    setBusy(true);
    try {
      const answer = await api.post<ArchiveAnswer | { message: string }>(
        `/admin/claims/${claim.id}/${claim.archived ? "unarchive" : "archive"}`,
        { confirm: confirmed },
      );
      if ("confirm" in answer && answer.confirm) {
        setConfirm(answer);
        return;
      }
      setConfirm(null);
      toast.success((answer as { message: string }).message);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={claim.reference}
        description="Claim"
        actions={
          claim.canOperate ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/claims/$claimId/retry" params={{ claimId: claim.id }}>
                  <RefreshCw />
                  Process again
                </Link>
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void archive()}>
                {claim.archived ? <ArchiveRestore /> : <Archive />}
                {claim.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" asChild>
                <Link to="/admin/claims/delete" search={{ ids: claim.id }}>
                  <Trash2 />
                  Delete
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <Card className="gap-0 py-0">
        <DetailList
          rows={[
            ["Reference", <span className="break-all">{claim.reference}</span>],
            ["Form", claim.form],
            ["Submitted", claim.submittedAt],
            ["Name", claim.fullName],
            ["Email", claim.email],
            ["Total (EUR)", claim.total],
          ]}
        />
      </Card>
      <Card className="gap-0 pb-0">
        <CardHeader className="border-b pb-4">
          <CardTitle>
            <h2>Processing</h2>
          </CardTitle>
        </CardHeader>
        <DetailList
          rows={[
            [
              "Status",
              <span className="inline-flex flex-wrap gap-1">
                <ToneBadge tone={claim.status.tone}>{claim.status.label}</ToneBadge>
                {claim.archived ? <ToneBadge tone="outline">Archived</ToneBadge> : null}
              </span>,
            ],
            ["Error", claim.error],
            ["Archived", claim.archivedAt],
            ["PDF deleted", claim.pdfRemovedAt],
            ["Content deleted from", claim.contentDue],
            ["Follow-up", claim.overdue ? <ToneBadge tone="warning">Overdue</ToneBadge> : ""],
          ]}
        />
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Logged actions</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {claim.operations.length === 0 ? (
            <p className="text-muted-foreground text-sm">None yet.</p>
          ) : (
            <Table scrollLabel="Logged actions">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claim.operations.map((operation) => (
                  <TableRow key={operation.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {operation.when}
                    </TableCell>
                    <TableCell>{operation.action}</TableCell>
                    <TableCell>{operation.actor}</TableCell>
                    <TableCell className="whitespace-normal">{operation.reason || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <ArchiveDialog answer={confirm} onCancel={() => setConfirm(null)} onConfirm={() => archive(true)} />
    </Page>
  );
}
