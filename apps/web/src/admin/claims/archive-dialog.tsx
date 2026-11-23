import { ConfirmDialog } from "@meldgrove/ui/confirm-dialog";
import type { ArchiveAnswer } from "@reimbursements/shared/api/admin";
import { ClaimSummaries } from "./claim-summaries";

/**
 * Archiving asks first when it deletes overdue claims at once: not resolved
 * within the retention period, they are kept only until resolved, and
 * retention deletes them within minutes once archived.
 */
export function ArchiveDialog({
  answer,
  onCancel,
  onConfirm,
}: {
  answer: Extract<ArchiveAnswer, { confirm: true }> | null;
  onCancel: () => void;
  onConfirm: () => unknown;
}) {
  const count = answer?.overdue.length ?? 0;
  const selected = answer?.selected ?? 0;
  const it = count === 1 ? "it" : "them";
  return (
    <ConfirmDialog
      open={answer !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={selected === 1 ? "Archive claim?" : `Archive ${selected} claims?`}
      description={
        count === 1
          ? selected === 1
            ? "The claim is deleted for good within minutes."
            : "1 claim is deleted for good within minutes."
          : `${count} claims are deleted for good within minutes.`
      }
      confirmLabel={selected === 1 ? "Archive claim" : `Archive ${selected} claims`}
      destructive
      onConfirm={onConfirm}
    >
      {answer ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            Not resolved within {answer.retentionDays} days of submission,{" "}
            {count === 1 ? "it is" : "they are"} kept only until resolved. Once archived, retention deletes{" "}
            {it} with name, address, bank details, expenses, receipts, signature and PDF. Unarchiving cannot
            bring {it} back.
          </p>
          <ClaimSummaries claims={answer.overdue} label="Claims deleted after archiving" />
          {selected > count ? (
            <p className="text-muted-foreground">
              The other selected claims are archived and keep their usual deletion dates.
            </p>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
