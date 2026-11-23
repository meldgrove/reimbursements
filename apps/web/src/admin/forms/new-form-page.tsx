import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, LayoutTemplate } from "lucide-react";
import { Card, CardContent } from "@meldgrove/ui/card";
import { Page } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { formTemplatesQuery } from "../api";

/** Step 1 of a new form: the template sets its internal values and what participants give. */
export function NewFormPage() {
  const query = useQuery(formTemplatesQuery);
  return (
    <Page>
      <div className="grid gap-1">
        <p className="text-muted-foreground text-sm font-medium">Step 1 of 2</p>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a template</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          The template sets which internal values (e.g. KST, KTR) you enter and which details participants
          give. It cannot be changed later.
        </p>
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <Card className="items-center py-12 text-center">
          <LayoutTemplate className="text-muted-foreground size-8" />
          <CardContent className="grid gap-1">
            <p className="font-medium">There are no templates yet</p>
            <p className="text-muted-foreground text-sm">
              Template admins create templates in the Admin section.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {query.data.map((template) => (
            <li key={template.id}>
              <Link
                to="/admin/forms/$formId"
                params={{ formId: "new" }}
                search={{ template: template.id }}
                className="group bg-card text-card-foreground hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-ring/50 flex h-full flex-col gap-3 rounded-xl border p-5 shadow-sm outline-none transition-colors focus-visible:ring-[3px]"
              >
                <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                  <LayoutTemplate className="size-4" />
                </span>
                <span className="font-semibold">{template.name}</span>
                {template.description ? (
                  <span className="text-muted-foreground text-sm whitespace-pre-line">
                    {template.description}
                  </span>
                ) : null}
                <span className="text-primary mt-auto inline-flex items-center gap-1 text-sm font-medium">
                  Use this template
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
