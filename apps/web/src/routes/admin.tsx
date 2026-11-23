import { useEffect } from "react";
import { createRoute, Link, Outlet, redirect, useRouter, useRouterState } from "@tanstack/react-router";
import { Receipt } from "lucide-react";
import { AppFrame, type FrameLink, type NavGroup, type SearchResult } from "@meldgrove/ui/app-frame";
import { useThemePreference } from "@meldgrove/ui/theme";
import { UpdateButton } from "@meldgrove/ui/updates";
import { APP_SHORT_NAME } from "@reimbursements/shared/constants";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { metaQuery, useMe, useMeta } from "@/lib/meta";
import { queryClient } from "@/lib/query";
import { breadcrumbsFor, navigationFor, SETTINGS_PATH } from "@/admin/navigation";
import { useRecordNameFor } from "@/admin/record-name";
import { AdminUpdates } from "@/admin/updates";
import { rootRoute } from "./root";

/**
 * TanStack Router's link for the frame: every other prop goes on to the <a>.
 * Exact, so that the router marks only the page itself as current, not the
 * breadcrumb of its parent; the frame marks the sidebar item.
 */
const AppLink: FrameLink = ({ href, ...props }) => (
  <Link to={href} activeOptions={{ exact: true }} {...props} />
);

/**
 * Claims, forms and templates for the frame's search (GET /api/v1/admin/search):
 * what the person may open, archived ones marked. The frame finds the pages itself.
 */
async function findRecords(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  try {
    return await api.get<SearchResult[]>("/admin/search", { q: query }, signal);
  } catch {
    return [];
  }
}

/** The admin area's frame: @meldgrove/ui's AppFrame with the navigation of Reimbursements, always in English. */
export function AdminLayout() {
  const meta = useMeta();
  const me = useMe();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const record = useRecordNameFor(pathname);
  const [theme, setTheme] = useThemePreference();
  useEffect(() => {
    document.documentElement.lang = "en";
    document.title = `${APP_SHORT_NAME} · ${meta.appName}`;
  }, [meta.appName]);

  const nav: NavGroup[] = navigationFor(me).map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({ label: item.label, href: item.to, shortcut: item.shortcut })),
  }));
  const breadcrumbs = breadcrumbsFor(pathname, { items: nav.flatMap((group) => group.items), record });

  const signOut = async () => {
    const { redirect: target } = await api
      .post<{ redirect: string }>("/auth/logout")
      .catch(() => ({ redirect: "/admin/login" }));
    queryClient.clear();
    window.location.assign(target);
  };

  return (
    <AdminUpdates>
      <AppFrame
        app={{ name: APP_SHORT_NAME, icon: <Receipt /> }}
        nav={nav}
        pathname={pathname}
        link={AppLink}
        navigate={(href) => {
          const url = new URL(href, window.location.origin);
          void router.navigate({ to: url.pathname, search: Object.fromEntries(url.searchParams) as never });
        }}
        user={{
          name: me.name,
          email: me.email,
          detail: me.isTemplateAdmin ? "Template admin" : "Form editor",
        }}
        theme={theme}
        onThemeChange={setTheme}
        settingsHref={SETTINGS_PATH}
        onSignOut={() => void signOut()}
        breadcrumbs={breadcrumbs}
        search={{
          find: findRecords,
          allResultsHref: (query) => `/admin/search?q=${encodeURIComponent(query)}`,
        }}
        // The sign-in provider's account page is on the person's settings page, not here.
        headerEnd={meta.updatesButton ? <UpdateButton /> : null}
      >
        <Outlet />
      </AppFrame>
    </AdminUpdates>
  );
}

/** Sends everyone without access to the admin area to the sign-in page. */
export async function requireSignIn({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}) {
  const meta = await context.queryClient.fetchQuery(metaQuery);
  if (!meta.user) throw redirect({ to: "/admin/login", search: { next: location.href } });
}

/** The signed-in admin area; its pages (admin/routes.tsx) are children of this route. */
export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "admin",
  beforeLoad: requireSignIn,
  component: AdminLayout,
});

/** `beforeLoad` of pages for template admins: others see "not found" (the server checks it too). */
export async function requireTemplateAdmin({ context }: { context: { queryClient: QueryClient } }) {
  const meta = await context.queryClient.ensureQueryData(metaQuery);
  if (!meta.user?.isTemplateAdmin) throw redirect({ to: "/admin/claims" });
}
