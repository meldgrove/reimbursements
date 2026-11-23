import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Minus, Plus } from "lucide-react";
import { Button } from "@meldgrove/ui/button";
import { Card } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import { TRAVEL_LABELS } from "@reimbursements/shared/api/admin";
import { templatesRoute } from "../routes";
import { templatesQuery } from "../api";
import { ListSearch, ListToolbar, TextLink, plural } from "../parts";

/** Templates (template admins): which internal values and details a form asks for. */
export function TemplatesPage() {
  const { q } = templatesRoute.useSearch();
  const navigate = useNavigate({ from: "/admin/templates" });
  const query = useQuery(templatesQuery(q ?? ""));
  return (
    <Page>
      <PageHeader
        title="Templates"
        description="Templates set which internal values and details a form asks for."
        actions={
          <Button asChild>
            <Link to="/admin/templates/new">
              <Plus />
              Add template
            </Link>
          </Button>
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        <ListToolbar
          active={Boolean(q)}
          onReset={() => void navigate({ search: {} })}
          count={query.data ? plural(query.data.length, "template") : ""}
        >
          <ListSearch
            label="Search templates"
            placeholder="Name or description …"
            value={q ?? ""}
            onSearch={(value) => void navigate({ search: { q: value || undefined } })}
          />
        </ListToolbar>
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.length === 0 ? (
          <div className="py-10">
            <EmptyState
              title={q ? "No results" : "No templates yet"}
              description={q ? "Change the search." : undefined}
            />
          </div>
        ) : (
          <Table scrollLabel="Templates">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Travel details</TableHead>
                <TableHead>Mileage</TableHead>
                <TableHead className="text-right">Forms</TableHead>
                <TableHead>Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <TextLink to={`/admin/templates/${row.id}`}>{row.name}</TextLink>
                  </TableCell>
                  <TableCell>{TRAVEL_LABELS[row.travel]}</TableCell>
                  <TableCell>
                    {row.mileageEnabled ? (
                      <Check
                        className="size-4 text-emerald-600 dark:text-emerald-400"
                        aria-label="Mileage: yes"
                        role="img"
                      />
                    ) : (
                      <Minus className="text-muted-foreground size-4" aria-label="Mileage: no" role="img" />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.forms}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{row.updatedAt}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
