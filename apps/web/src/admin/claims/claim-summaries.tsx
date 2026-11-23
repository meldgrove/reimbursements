import type { ReactNode } from "react";
import type { ClaimSummary } from "@reimbursements/shared/api/admin";
import { ToneBadge } from "../parts";

/** Claims a confirmation is about: reference, form, date and name, and the status. */
export function ClaimSummaries({
  claims,
  label,
  extra,
}: {
  claims: ClaimSummary[];
  label: string;
  extra?: (claim: ClaimSummary) => ReactNode;
}) {
  return (
    <ul className="grid divide-y rounded-lg border text-sm" aria-label={label}>
      {claims.map((claim) => (
        <li key={claim.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          <span className="grid min-w-0 gap-0.5">
            <span className="font-medium break-all">{claim.reference}</span>
            <span className="text-muted-foreground">
              {claim.form} · submitted {claim.submittedOn}
              {claim.fullName ? ` · ${claim.fullName}` : ""}
            </span>
          </span>
          <span className="inline-flex flex-wrap gap-1">
            <ToneBadge tone={claim.status.tone}>{claim.status.label}</ToneBadge>
            {claim.archived ? <ToneBadge tone="outline">Archived</ToneBadge> : null}
            {extra?.(claim)}
          </span>
        </li>
      ))}
    </ul>
  );
}
