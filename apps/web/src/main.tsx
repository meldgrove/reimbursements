import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { queryClient } from "@/lib/query";
import { setUnauthorizedHandler } from "@/lib/api";
import { reportCaughtError, startErrorReporting } from "@/lib/error-reporting";
import { router } from "@/router";
import "./styles.css";

void startErrorReporting(() => router.state.matches.at(-1)?.fullPath);

// A 401 in the admin area means the session ended: show the sign-in page.
setUnauthorizedHandler(() => {
  const path = window.location.pathname;
  if (path.startsWith("/admin") && !path.startsWith("/admin/login")) {
    void queryClient.invalidateQueries({ queryKey: ["meta"] });
    void router.navigate({ to: "/admin/login", search: { next: path + window.location.search } });
  }
});

createRoot(document.getElementById("root")!, {
  // Errors that an error screen caught never reach window.onerror. Log them as
  // React does by default, and report them.
  onCaughtError: (error) => {
    console.error(error); // eslint-disable-line no-console
    reportCaughtError(error);
  },
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
