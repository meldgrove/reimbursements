import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateDetail } from "@reimbursements/shared/api/admin";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

/** Form editors open a template read-only, as in Django (test_admin's template links of form editors). */
afterEach(() => vi.unstubAllGlobals());

const DETAIL: TemplateDetail = {
  id: 1,
  template: {
    name: "Externe Erstattung",
    description: "",
    intro: "",
    travel: "optional",
    mileageEnabled: true,
    mileageRate: "0,30",
    declaration: "Hiermit bestätige ich …",
    declarationVersion: "reimbursement-v1",
    fields: [],
  },
  forms: 2,
  canChange: false,
  canDelete: false,
};

describe("a template", () => {
  it("opens read-only for form editors", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
      "GET /api/v1/admin/templates/1": { body: DETAIL },
    });
    const { router } = renderApp("/admin/templates/1");
    expect(await screen.findByDisplayValue("Externe Erstattung")).toBeDisabled();
    expect(router.state.location.pathname).toBe("/admin/templates/1");
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });
});
