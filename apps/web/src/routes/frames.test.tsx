import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("participant pages", () => {
  it("have no header, a skip link and the footer in the app language", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ operator: "Example e. V.", legalUrl: "https://example.invalid/impressum" }),
      },
    });
    const { container } = renderApp("/datenschutz");
    expect(await screen.findByText("Zum Inhalt")).toHaveAttribute("href", "#main");
    expect(container.querySelector("header")).toBeNull();
    expect(screen.getByText("Example e. V.")).toBeInTheDocument();
    expect(screen.getByText("Impressum")).toHaveAttribute("href", "https://example.invalid/impressum");
    expect(screen.getByText("Datenschutz")).toBeInTheDocument();
  });

  it("follow an English app language", async () => {
    mockApi({ "/api/v1/meta": { body: testMeta({ settings: { ...testMeta().settings, language: "en" } }) } });
    renderApp("/");
    expect(await screen.findByText("Skip to content")).toBeInTheDocument();
  });
});

describe("admin area", () => {
  it("sends people without a session to the sign-in page", async () => {
    mockApi({ "/api/v1/meta": { body: testMeta() } });
    const { router } = renderApp("/admin/forms");
    expect(await screen.findByText("Sign in with Keycloak")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/login"));
    expect(router.state.location.search).toMatchObject({ next: "/admin/forms" });
  });

  it("shows the app frame with the navigation of a template admin", async () => {
    mockApi({ "/api/v1/meta": { body: testMeta({ user: ADMIN }) } });
    const { router } = renderApp("/admin");
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    for (const label of ["Forms", "General", "Email", "Templates", "Privacy notice", "Updates"]) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
  });

  it("keeps form editors out of the Admin group", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
    });
    const { router } = renderApp("/admin/general");
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(screen.queryByText("Templates")).toBeNull();
  });
});
