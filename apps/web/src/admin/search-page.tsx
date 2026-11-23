import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@meldgrove/ui/states";
import { searchRoute } from "./routes";
import { searchQuery } from "./api";
import { ListSearch, TextLink, ToneBadge } from "./parts";

/** Every result of a search: matching pages, claims, forms and (for template admins) templates. */
export function SearchPage() {
  const { q = "" } = searchRoute.useSearch();
  const navigate = useNavigate({ from: "/admin/search" });
  const query = useQuery({ ...searchQuery(q), enabled: q.trim().length >= 2 });
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Search" description={q ? `Results for “${q}”` : "Claims, forms and templates."} />
      <ListSearch
        label="Search"
        placeholder="Search …"
        value={q}
        onSearch={(value) => void navigate({ search: { q: value || undefined } })}
      />
      {q.trim().length < 2 ? (
        <p className="text-muted-foreground text-sm">Type at least two characters.</p>
      ) : query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          title="No results"
          description="Try another word, a name, an email address or a reference."
        />
      ) : (
        query.data.map((group) => (
          <Card key={group.label}>
            <CardHeader>
              <CardTitle>
                <h2>{group.label}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid divide-y text-sm">
                {group.items.map((item) => (
                  <li key={item.url} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="grid gap-0.5">
                      <TextLink to={item.url}>{item.name}</TextLink>
                      {item.detail ? <span className="text-muted-foreground">{item.detail}</span> : null}
                    </span>
                    <ToneBadge tone="secondary">{item.kind}</ToneBadge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </Page>
  );
}
