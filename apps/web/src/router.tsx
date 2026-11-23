import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { LoadingState } from "@meldgrove/ui/states";
import { queryClient } from "@/lib/query";
import { rootRoute } from "@/routes/root";
import { participantRoute } from "@/routes/participant";
import { adminRoute } from "@/routes/admin";
import { devSignInRoute, noAccessRoute, signInRoute } from "@/routes/sign-in";
import { participantRoutes } from "@/participant/routes";
import { adminRoutes } from "@/admin/routes";

const routeTree = rootRoute.addChildren([
  participantRoute.addChildren(participantRoutes),
  signInRoute,
  devSignInRoute,
  noAccessRoute,
  adminRoute.addChildren(adminRoutes),
]);

/** The app's router; tests pass a memory history and their own query client. */
export function createAppRouter(options: { history?: RouterHistory; queryClient?: QueryClient } = {}) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient ?? queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => <LoadingState />,
    scrollRestoration: true,
    // Paths of the Django version end with a slash: /f/demo/ opens /f/demo.
    trailingSlash: "never",
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
