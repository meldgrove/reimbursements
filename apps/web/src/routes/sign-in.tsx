import { useState } from "react";
import { createRoute, notFound, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { LogIn, Receipt } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { Label } from "@meldgrove/ui/label";
import { SignInPage as SignInLayout } from "@meldgrove/ui/sign-in-page";
import { Spinner } from "@meldgrove/ui/spinner";
import { APP_SHORT_NAME, APP_TAGLINE, REPOSITORY_URL } from "@reimbursements/shared/constants";
import { api, errorMessage } from "@/lib/api";
import { metaQuery, useMeta } from "@/lib/meta";
import { queryClient } from "@/lib/query";
import { rootRoute } from "./root";

const searchSchema = z.object({
  next: z.string().optional().catch(undefined),
  error: z.enum(["denied", "unavailable"]).optional().catch(undefined),
});

/** Only paths of the admin area, never another origin. */
export function safeNext(target: string | undefined): string {
  return target &&
    target.startsWith("/admin") &&
    !target.startsWith("//") &&
    !target.startsWith("/\\") &&
    !target.startsWith("/admin/login")
    ? target
    : "/admin/claims";
}

function SignInPage() {
  const meta = useMeta();
  const search = signInRoute.useSearch();
  const [pending, setPending] = useState(false);
  const target = `/oidc/authenticate/?next=${encodeURIComponent(safeNext(search.next))}`;
  return (
    <SignInLayout
      app={{ name: APP_SHORT_NAME, icon: <Receipt /> }}
      tagline={APP_TAGLINE}
      repositoryUrl={REPOSITORY_URL}
    >
      {search.error === "denied" ? (
        <Alert variant="destructive">
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription>The sign-in did not check out. Try again.</AlertDescription>
        </Alert>
      ) : null}
      {search.error === "unavailable" ? (
        <Alert variant="destructive">
          <AlertTitle>Sign-in unavailable</AlertTitle>
          <AlertDescription>
            The sign-in provider cannot be reached right now. Try again in a minute.
          </AlertDescription>
        </Alert>
      ) : null}
      {!meta.auth.oidcEnabled ? (
        <Alert>
          <AlertDescription>
            Sign-in is not set up. Set KEYCLOAK_BASE_URL, KEYCLOAK_REALM, OIDC_CLIENT_ID and
            OIDC_CLIENT_SECRET (docs/deployment.md).
          </AlertDescription>
        </Alert>
      ) : (
        <Button asChild disabled={pending}>
          {/* A full page load: the server redirects to the provider. */}
          <a href={target} onClick={() => setPending(true)}>
            {pending ? <Spinner /> : <LogIn />}
            {`Sign in with ${meta.auth.providerName}`}
          </a>
        </Button>
      )}
      {meta.auth.devLogin ? (
        <p className="text-muted-foreground text-sm">
          <a className="underline underline-offset-4" href="/admin/login/dev">
            Development sign-in
          </a>
        </p>
      ) : null}
    </SignInLayout>
  );
}

/** Away from the sign-in pages when a session with access exists already. */
async function leaveWhenSignedIn(next: string | undefined) {
  const meta = await queryClient.fetchQuery(metaQuery);
  if (meta.user) throw redirect({ to: safeNext(next) });
}

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/login",
  validateSearch: searchSchema,
  // With an error to show, the page stays, signed in or not.
  beforeLoad: ({ search }) => (search.error ? undefined : leaveWhenSignedIn(search.next)),
  component: SignInPage,
});

type DevUser = { username: string; name: string; email: string; roles: string[] };

function DevSignInPage() {
  const users = useQuery({ queryKey: ["dev-users"], queryFn: () => api.get<DevUser[]>("/auth/dev-users") });
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chosen = username || users.data?.[0]?.username || "";
  const signIn = async () => {
    setError(null);
    try {
      await api.post("/auth/dev-login", { username: chosen });
      window.location.assign("/admin/claims");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  return (
    <SignInLayout
      app={{ name: APP_SHORT_NAME, icon: <Receipt /> }}
      tagline={APP_TAGLINE}
      repositoryUrl={REPOSITORY_URL}
    >
      <Alert>
        <AlertDescription>Development only. Never enable DEV_LOGIN on a server.</AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {users.data && users.data.length === 0 ? (
        <Alert>
          <AlertDescription>
            No user with a role yet. Create one: npm run cli -- create-superuser --username dev
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="dev-user">User</Label>
        <NativeSelect id="dev-user" value={chosen} onChange={(event) => setUsername(event.target.value)}>
          {(users.data ?? []).map((user) => (
            <NativeSelectOption key={user.username} value={user.username}>
              {user.name} ({user.roles.join(", ")})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <Button type="button" onClick={() => void signIn()} disabled={!chosen}>
        Sign in
      </Button>
    </SignInLayout>
  );
}

export const devSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/login/dev",
  beforeLoad: async ({ context }) => {
    // Development only: elsewhere the page does not exist.
    const meta = await context.queryClient.ensureQueryData(metaQuery);
    if (!meta.auth.devLogin) throw notFound();
    await leaveWhenSignedIn(undefined);
  },
  component: DevSignInPage,
});

/**
 * Someone who signed in without a verified email address or a role group
 * (the Django version's /admin/no-access/).
 */
function NoAccessPage() {
  return (
    <SignInLayout
      app={{ name: APP_SHORT_NAME, icon: <Receipt /> }}
      tagline={APP_TAGLINE}
      repositoryUrl={REPOSITORY_URL}
    >
      <Alert variant="destructive">
        <AlertTitle>No access</AlertTitle>
        <AlertDescription>
          Your account has no access to the admin area. Ask an administrator to add you to the template admins
          or the form editors, then sign in again.
        </AlertDescription>
      </Alert>
      <Button asChild variant="outline">
        <a href="/admin/login">Back to sign-in</a>
      </Button>
    </SignInLayout>
  );
}

export const noAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/no-access",
  component: NoAccessPage,
});
