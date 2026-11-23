import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ADMIN, testMeta } from "@/test-utils";
import { AdminUpdates } from "./updates";

const provided = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@meldgrove/ui/updates", () => ({
  UpdatesProvider: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    provided.props = props;
    return props.children;
  },
}));

/** The update button shows dates as the rest of the admin area: Admin > General's format and timezone. */
describe("the update status", () => {
  it("takes the app's timezone and the locale of its date format", async () => {
    const queryClient = new QueryClient();
    const meta = testMeta({ user: ADMIN });
    queryClient.setQueryData(["meta"], {
      ...meta,
      settings: { ...meta.settings, timezone: "America/New_York", dateFormat: "m/d/Y" },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Suspense>
          <AdminUpdates>
            <p>page</p>
          </AdminUpdates>
        </Suspense>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("page")).toBeInTheDocument();
    expect(provided.props).toMatchObject({ timeZone: "America/New_York", dateLocale: "en-US" });
  });
});
