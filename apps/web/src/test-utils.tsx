import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { vi } from "vitest";
import type { Meta, MeUser } from "@reimbursements/shared/api/meta";
import { createAppRouter } from "@/router";

/** A meta answer (GET /api/v1/meta) with the defaults of a new installation. */
export function testMeta(overrides: Partial<Meta> = {}): Meta {
  return {
    appName: "Meldgrove Reimbursement",
    version: "",
    settings: {
      language: "de",
      timezone: "Europe/Berlin",
      dateFormat: "d.m.Y",
      numberFormat: "european",
      accentColor: "",
      faviconDigest: "",
      faviconType: "",
      operator: "",
      legalUrl: "",
    },
    operator: "",
    legalUrl: "",
    user: null,
    updatesButton: false,
    accountUrl: "",
    auth: { oidcEnabled: true, providerName: "Keycloak", devLogin: false },
    ...overrides,
  };
}

export const ADMIN: MeUser = {
  id: 1,
  name: "Ada Admin",
  email: "ada@example.invalid",
  roles: ["Vorlagen-Admins"],
  isTemplateAdmin: true,
  isFormEditor: true,
};

type Answer = { status?: number; body: unknown };

/**
 * Answers the app's API calls in tests: `routes` maps "GET /api/v1/meta" (or
 * a path without method) to an answer or a function of the request.
 */
export function mockApi(routes: Record<string, Answer | ((request: Request) => Answer)>) {
  const calls: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      new URL(String(input instanceof Request ? input.url : input), "http://localhost"),
      init,
    );
    calls.push(request);
    const url = new URL(request.url);
    const answer = routes[`${request.method} ${url.pathname}`] ?? routes[url.pathname];
    if (!answer)
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), {
        status: 404,
      });
    const { status = 200, body } = typeof answer === "function" ? answer(request) : answer;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

/** Renders the whole app at `path`, with a fresh query client. */
export function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }), queryClient });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}
