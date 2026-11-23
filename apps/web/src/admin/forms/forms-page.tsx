import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, Minus, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@meldgrove/ui/button";
import { Card } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { ConfirmDialog } from "@meldgrove/ui/confirm-dialog";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { Pager } from "@meldgrove/ui/pager";
import { EmptyState, ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import { FORM_STATUS_LABELS, FORM_STATUS_TONES, type FormList } from "@reimbursements/shared/api/admin";
import { api, errorMessage } from "@/lib/api";
import { formsRoute } from "../routes";
import { formsQuery, type FormsSearch } from "../api";
import { ListFilter, ListSearch, ListToolbar, TextLink, ToneBadge, plural } from "../parts";

const PAGE_SIZE = 100;
const STATUS_OPTIONS = (["draft", "published", "archived"] as const).map((value) => ({
  value,
  label: FORM_STATUS_LABELS[value],
}));

/** Yes or no, as Django's boolean icons. */
function YesNo({ value, label }: { value: boolean; label: string }) {
  return value ? (
    <Check
      className="size-4 text-emerald-600 dark:text-emerald-400"
      aria-label={`${label}: yes`}
      role="img"
    />
  ) : (
    <Minus className="text-muted-foreground size-4" aria-label={`${label}: no`} role="img" />
  );
}

/**
 * Forms (the Django admin's form list): participants submit their expenses
 * through a form's link. Open now says whether a form takes claims, and why
 * an open one does not.
 */
export function FormsPage() {
  const search = formsRoute.useSearch();
  const navigate = useNavigate({ from: "/admin/forms" });
  const queryClient = useQueryClient();
  const query = useQuery({ ...formsQuery(search), placeholderData: keepPreviousData });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const archivedList = search.status === "archived";

  const go = (changes: Partial<FormsSearch>) => {
    setSelected(new Set());
    void navigate({ search: (current) => ({ ...current, page: undefined, ...changes }) });
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

  const archive = async () => {
    try {
      const answer = await api.post<{ message: string }>("/admin/forms/archive", {
        ids: [...selected],
        archived: !archivedList,
      });
      toast.success(answer.message);
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const remove = async () => {
    try {
      const answer = await api.post<{ message: string }>("/admin/forms/delete", { ids: [...selected] });
      toast.success(answer.message);
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  const filtered = Boolean(search.status || search.primary || search.template || search.q);
  return (
    <Page>
      <PageHeader
        title="Forms"
        description="Participants submit their expenses through a form's link."
        actions={
          <Button asChild>
            <Link to="/admin/forms/$formId" params={{ formId: "new" }}>
              <Plus />
              Add form
            </Link>
          </Button>
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        <ListToolbar
          active={filtered}
          onReset={() => go({ status: undefined, primary: undefined, template: undefined, q: undefined })}
          count={query.data ? plural(query.data.count, "form") : ""}
        >
          <ListSearch
            label="Search forms"
            placeholder="Name or short name …"
            value={search.q ?? ""}
            onSearch={(q) => go({ q: q || undefined })}
          />
          <ListFilter
            label="Status"
            all="All except archived"
            value={search.status ?? ""}
            options={STATUS_OPTIONS}
            onChange={(status) => go({ status: status || undefined })}
          />
          <ListFilter
            label="Start page"
            all="Any start page"
            value={search.primary ?? ""}
            options={[
              { value: "1", label: "Start page" },
              { value: "0", label: "Not the start page" },
            ]}
            onChange={(primary) => go({ primary: primary || undefined })}
          />
          <ListFilter
            label="Template"
            all="All templates"
            value={search.template ?? ""}
            options={query.data?.templates ?? []}
            onChange={(template) => go({ template: template || undefined })}
          />
        </ListToolbar>
        {selected.size > 0 ? (
          <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
            <span className="text-muted-foreground">{plural(selected.size, "form")} selected</span>
            <Button variant="outline" size="sm" onClick={() => void archive()}>
              {archivedList ? <ArchiveRestore /> : <Archive />}
              {archivedList ? "Unarchive selected forms" : "Archive selected forms"}
            </Button>
            {query.data?.canDelete ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                Delete selected forms
              </Button>
            ) : null}
          </div>
        ) : null}
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.rows.length === 0 ? (
          <div className="py-10">
            <EmptyState
              title={filtered ? "No results" : "No forms yet"}
              description={
                filtered
                  ? "Change the search or reset the filters."
                  : "Create a form from a template and share its link."
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
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${plural(selected.size, "form")}?`}
        description="Only drafts and archived forms without claims can be deleted. They and their links are deleted permanently. This cannot be undone."
        confirmLabel="Delete for good"
        destructive
        onConfirm={remove}
      />
    </Page>
  );
}

function Rows({
  list,
  selected,
  onSelect,
}: {
  list: FormList;
  selected: Set<number>;
  onSelect: (selected: Set<number>) => void;
}) {
  const ids = list.rows.map((row) => row.id);
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelect(next);
  };
  return (
    <Table scrollLabel="Forms">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              aria-label="Select all forms on this page"
              checked={all}
              onCheckedChange={(on) => onSelect(on ? new Set(ids) : new Set())}
            />
          </TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Template</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Start page</TableHead>
          <TableHead>Internal values complete</TableHead>
          <TableHead>Open now</TableHead>
          <TableHead>Closes</TableHead>
          <TableHead>Link</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.rows.map((row) => (
          <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
            <TableCell>
              <Checkbox
                aria-label={`Select form ${row.name}`}
                checked={selected.has(row.id)}
                onCheckedChange={(on) => toggle(row.id, on === true)}
              />
            </TableCell>
            <TableCell>
              <TextLink to={`/admin/forms/${row.id}`}>{row.name}</TextLink>
            </TableCell>
            <TableCell>{row.template}</TableCell>
            <TableCell>
              <ToneBadge tone={FORM_STATUS_TONES[row.status]}>{FORM_STATUS_LABELS[row.status]}</ToneBadge>
            </TableCell>
            <TableCell>
              <YesNo value={row.primary} label="Start page" />
            </TableCell>
            <TableCell>
              <YesNo value={row.valuesComplete} label="Internal values complete" />
            </TableCell>
            <TableCell>
              <span className="inline-flex items-center gap-1.5">
                <YesNo value={row.openNow} label="Open now" />
                {row.unavailable ? <span className="text-muted-foreground">{row.unavailable}</span> : null}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">{row.closesAt || "—"}</TableCell>
            <TableCell className="max-w-64 truncate">
              <a
                href={row.link}
                target="_blank"
                rel="noopener"
                className="underline-offset-4 hover:underline"
              >
                {row.link}
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
