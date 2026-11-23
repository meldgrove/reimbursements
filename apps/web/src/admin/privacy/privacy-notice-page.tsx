import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { Button } from "@meldgrove/ui/button";
import { Card } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import { privacyNoticesQuery } from "../api";
import { TextLink } from "../parts";

/** The privacy notice's versions (template admins): participants always see the latest. */
export function PrivacyNoticePage() {
  const query = useQuery(privacyNoticesQuery);
  return (
    <Page>
      <PageHeader
        title="Privacy notice"
        description="Participants always see the latest version. Every change is saved as a new version."
        actions={
          <Button asChild>
            <Link to="/admin/privacy-notice/new">
              <Plus />
              New version
            </Link>
          </Button>
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.length === 0 ? (
          <p className="text-muted-foreground p-6 text-sm">
            No privacy notice yet. Forms take claims only once there is one.
          </p>
        ) : (
          <Table scrollLabel="Privacy notice versions">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Current</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <TextLink to={`/admin/privacy-notice/${row.id}`}>Version {row.version}</TextLink>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{row.createdAt}</TableCell>
                  <TableCell>{row.createdBy || "—"}</TableCell>
                  <TableCell>
                    {row.current ? (
                      <Check
                        className="size-4 text-emerald-600 dark:text-emerald-400"
                        aria-label="Current"
                        role="img"
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
