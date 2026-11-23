import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "@meldgrove/ui/sonner";
import { EmptyState } from "@meldgrove/ui/states";
import { useThemePreference } from "@meldgrove/ui/theme";
import { metaQuery, useMetaMaybe } from "@/lib/meta";
import { useAppearance } from "@/lib/appearance";

export type RouterContext = { queryClient: QueryClient };

function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState title="Not found" description="This page does not exist." />
    </div>
  );
}

/** Every page of both areas: the person's appearance (kept in this browser), the accent and favicon, the toasts. */
function Root() {
  useThemePreference();
  useAppearance(useMetaMaybe()?.settings);
  return (
    <>
      <Outlet />
      {/* Above the sticky save bars of forms, so a toast never covers Save. */}
      <Toaster richColors closeButton offset={{ bottom: 80 }} mobileOffset={{ bottom: 80 }} />
    </>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  // The settings and the signed-in person come first for every page.
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(metaQuery),
  component: Root,
  notFoundComponent: NotFound,
});
