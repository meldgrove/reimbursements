import { Page, PageHeader } from "@meldgrove/ui/page";

/**
 * A page that is not ported yet. TODO(INTAKE, ADMIN): every use of it goes
 * away when the page's agent fills its file.
 */
export function Placeholder({ title, owner }: { title: string; owner: string }) {
  return (
    <Page>
      <PageHeader title={title} description={`Not ported yet (${owner}).`} />
    </Page>
  );
}
