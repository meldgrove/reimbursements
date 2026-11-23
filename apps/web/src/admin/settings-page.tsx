import { Button } from "@meldgrove/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@meldgrove/ui/settings-cards";
import { useThemePreference } from "@meldgrove/ui/theme";
import { APP_SHORT_NAME, REPOSITORY_URL } from "@reimbursements/shared/constants";
import { useMeta } from "@/lib/meta";

/** The sign-in provider's account page (Keycloak's account console), where people manage their sign-in. */
function AccountCard({ url }: { url: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Your name, email address and password are managed by the sign-in provider.
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" size="sm" asChild>
          <a href={url}>Manage account</a>
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The person's own settings (Settings in the user menu): account, appearance,
 * single-letter shortcuts (WCAG 2.1.4), about.
 */
export function SettingsPage() {
  const meta = useMeta();
  const [theme, setTheme] = useThemePreference();
  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="Settings"
        description="Your account and how this app looks and responds to keys in this browser."
      />
      {meta.accountUrl ? <AccountCard url={meta.accountUrl} /> : null}
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      <AboutCard appName={APP_SHORT_NAME} repositoryUrl={REPOSITORY_URL} />
    </Page>
  );
}
