import { Page, PageHeader } from "@meldgrove/ui/page";
import { UpdatesSettingsCard } from "@meldgrove/ui/updates";

/** Admin › Updates: which versions this server installs, and when (template admins). */
export function UpdatesPage() {
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Updates" description="Which versions this server installs, and when." />
      <UpdatesSettingsCard />
    </Page>
  );
}
