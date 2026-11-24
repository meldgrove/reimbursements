import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettingsPage } from "@reimbursements/shared/api/admin";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

/** Admin › General as admins see it (the server's rules are in modules/admin/settings.int.test.ts). */
afterEach(() => vi.unstubAllGlobals());

const URL = "/api/v1/admin/settings/general";

function generalPage(overrides: Partial<GeneralSettingsPage> = {}): GeneralSettingsPage {
  return {
    settings: {
      language: "de",
      timezone: "Europe/Berlin",
      dateFormat: "d.m.Y",
      numberFormat: "european",
      operator: "",
      legalUrl: "",
    },
    choices: {
      languages: [
        { value: "de", label: "Deutsch" },
        { value: "en", label: "English" },
      ],
      timezones: [{ value: "Europe/Berlin", label: "Europe/Berlin" }],
      dateFormats: [{ value: "d.m.Y", label: "31.12.2026" }],
      numberFormats: [{ value: "european", label: "1.234,56" }],
    },
    version: "Built from source",
    ...overrides,
  };
}

const meta = { "/api/v1/meta": { body: testMeta({ user: ADMIN }) } };

describe("Admin › General", () => {
  it("saves the operator and the legal page with the other settings", async () => {
    const { calls } = mockApi({
      ...meta,
      [`GET ${URL}`]: { body: generalPage() },
      [`PUT ${URL}`]: {
        body: {
          ...generalPage({
            settings: {
              ...generalPage().settings,
              operator: "Example e.V.",
              legalUrl: "https://example.invalid/imprint",
            },
          }),
          message: "The general settings were saved.",
        },
      },
    });
    const user = userEvent.setup();
    renderApp("/admin/general");
    await screen.findByRole("heading", { name: "General", level: 1 });
    await user.type(screen.getByLabelText("Operator"), "Example e.V.");
    await user.type(screen.getByLabelText("Legal page"), "https://example.invalid/imprint");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The general settings were saved.")).toBeInTheDocument();
    const put = calls.find((request) => request.method === "PUT")!;
    expect(await put.json()).toEqual({
      language: "de",
      timezone: "Europe/Berlin",
      dateFormat: "d.m.Y",
      numberFormat: "european",
      operator: "Example e.V.",
      legalUrl: "https://example.invalid/imprint",
    });
  });
});
