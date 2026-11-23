import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@meldgrove/ui/button";
import { Card } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { Pager } from "@meldgrove/ui/pager";
import { EmptyState, ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import type { ArchiveAnswer, ClaimList } from "@reimbursements/shared/api/admin";
import { api, errorMessage } from "@/lib/api";
import { claimsRoute } from "../routes";
import { claimsQuery, type ClaimsSearch } from "../api";
import { ListFilter, ListSearch, ListToolbar, TextLink, ToneBadge, plural } from "../parts";
import { ArchiveDialog } from "./archive-dialog";

const PAGE_SIZE = 100;

/**
 * Claims (the Django admin's claim list): what participants submitted and how
 * far it has been processed. Template admins archive, unarchive and delete
 * selected claims.
 */
export function ClaimsPage() {
  const search = claimsRoute.useSearch();
  const navigate = useNavigate({ from: "/admin/claims" });
  const queryClient = useQueryClient();
  const query = useQuery({ ...claimsQuery(search), placeholderData: keepPreviousData });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<Extract<ArchiveAnswer, { confirm: true }> | null>(null);
  const archivedList = search.status === "archived";

  const go = (changes: Partial<ClaimsSearch>) => {
    setSelected(new Set());
    void navigate({ search: (current) => ({ ...current, page: undefined, ...changes }) });
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

  const archiveSelected = async (confirm = false) => {
    try {
      const answer = await api.post<ArchiveAnswer>(
        archivedList ? "/admin/claims/unarchive" : "/admin/claims/archive",
        {
          ids: [...selected],
          confirm,
        },
      );
      if ("confirm" in answer && answer.confirm) {
        setArchive(answer);
        return;
      }
      toast.success((answer as { message: string }).message);
      setArchive(null);
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const filtered = Boolean(search.status || search.form || search.q || search.year);
  return (
    <Page>
      <PageHeader title="Claims" description="Submitted claims and how far they have been processed." />
      <Card className="gap-0 overflow-hidden py-0">
        <ListToolbar
          active={filtered}
          onReset={() =>
            go({
              status: undefined,
              form: undefined,
              q: undefined,
              year: undefined,
              month: undefined,
              day: undefined,
            })
          }
          count={query.data ? plural(query.data.count, "claim") : ""}
        >
          <ListSearch
            label="Search claims"
            placeholder="Name, email or reference …"
            value={search.q ?? ""}
            onSearch={(q) => go({ q: q || undefined })}
          />
          <ListFilter
            label="Form"
            all="All forms"
            value={search.form ?? ""}
            options={query.data?.forms ?? []}
            onChange={(form) => go({ form: form || undefined })}
          />
          <ListFilter
            label="Status"
            all="All except archived"
            value={search.status ?? ""}
            options={query.data?.statuses ?? []}
            onChange={(status) => go({ status: status || undefined })}
          />
        </ListToolbar>
        {query.data ? <Dates list={query.data} search={search} go={go} /> : null}
        {query.data?.canOperate && selected.size > 0 ? (
          <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
            <span className="text-muted-foreground">{plural(selected.size, "claim")} selected</span>
            <Button variant="outline" size="sm" onClick={() => void archiveSelected()}>
              {archivedList ? <ArchiveRestore /> : <Archive />}
              {archivedList ? "Unarchive selected claims" : "Archive selected claims"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() =>
                void navigate({ to: "/admin/claims/delete", search: { ids: [...selected].join(",") } })
              }
            >
              <Trash2 />
              Delete selected claims
            </Button>
          </div>
        ) : null}
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.rows.length === 0 ? (
          <div className="py-10">
            <EmptyState
              title={filtered ? "No results" : "No claims yet"}
              description={
                filtered
                  ? "Change the search or reset the filters."
                  : "As soon as participants submit a form, the claim appears here."
              }
            />
          </div>
        ) : (
          <Rows list={query.data} selected={selected} onSelect={setSelected} />
        )}
      </Card>
      {query.data && query.data.pages > 1 ? (
        <Pager
          page={query.data.page}
          pageSize={PAGE_SIZE}
          total={query.data.count}
          onPage={(page) => go({ page })}
        />
      ) : null}
      <ArchiveDialog
        answer={archive}
        onCancel={() => setArchive(null)}
        onConfirm={() => archiveSelected(true)}
      />
    </Page>
  );
}

/** Django's date hierarchy: the years, then the months of a year, then its days. */
function Dates({
  list,
  search,
  go,
}: {
  list: ClaimList;
  search: ClaimsSearch;
  go: (changes: Partial<ClaimsSearch>) => void;
}) {
  const { crumbs, options } = list.dates;
  if (crumbs.length === 0 && options.length <= 1) return null;
  const pick = (value: string) => {
    if (!search.year) go({ year: value });
    else if (!search.month) go({ month: value });
    else go({ day: value });
  };
  const back = (value: string) => {
    if (!value) go({ year: undefined, month: undefined, day: undefined });
    else if (/^\d+$/.test(value)) go({ year: value, month: undefined, day: undefined });
    else {
      const [year, month] = value.split("-");
      go({ year, month, day: undefined });
    }
  };
  return (
    <nav
      aria-label="Dates"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-sm"
    >
      {crumbs.map((crumb) => (
        <button
          key={crumb.label}
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => back(crumb.value)}
        >
          ‹ {crumb.label}
        </button>
      ))}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="font-medium underline-offset-4 hover:underline"
          onClick={() => pick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  );
}

function Rows({
  list,
  selected,
  onSelect,
}: {
  list: ClaimList;
  selected: Set<string>;
  onSelect: (selected: Set<string>) => void;
}) {
  const ids = list.rows.map((row) => row.id);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelect(next);
  };
  return (
    <Table scrollLabel="Claims">
      <TableHeader>
        <TableRow>
          {list.canOperate ? (
            <TableHead className="w-10">
              <Checkbox
                aria-label="Select all claims on this page"
                checked={all}
                onCheckedChange={(on) => onSelect(on ? new Set(ids) : new Set())}
              />
            </TableHead>
          ) : null}
          <TableHead>Reference</TableHead>
          <TableHead>Form</TableHead>
          <TableHead>Submitted</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead className="text-right">Total (EUR)</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Follow-up</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.rows.map((row) => (
          <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
            {list.canOperate ? (
              <TableCell>
                <Checkbox
                  aria-label={`Select claim ${row.reference}`}
                  checked={selected.has(row.id)}
                  onCheckedChange={(on) => toggle(row.id, on === true)}
                />
              </TableCell>
            ) : null}
            <TableCell className="font-mono text-xs">
              <TextLink to={`/admin/claims/${row.id}`}>{row.reference}</TextLink>
            </TableCell>
            <TableCell>{row.form}</TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">{row.submittedAt}</TableCell>
            <TableCell>{row.fullName}</TableCell>
            <TableCell className="text-muted-foreground">{row.email}</TableCell>
            <TableCell className="text-right tabular-nums">{row.total}</TableCell>
            <TableCell>
              <span className="inline-flex flex-wrap gap-1">
                <ToneBadge tone={row.status.tone}>{row.status.label}</ToneBadge>
                {row.archived ? <ToneBadge tone="outline">Archived</ToneBadge> : null}
              </span>
            </TableCell>
            <TableCell>{row.overdue ? <ToneBadge tone="warning">Overdue</ToneBadge> : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
