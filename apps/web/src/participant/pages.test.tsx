import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormPage, ReceivedAnswer } from "@reimbursements/shared/api/public";
import { mockApi, renderApp, testMeta } from "@/test-utils";

afterEach(() => vi.unstubAllGlobals());

const meta = { "/api/v1/meta": { body: testMeta() } };

function formPage(overrides: Partial<FormPage> = {}): FormPage {
  return {
    state: "open",
    form: {
      slug: "demo",
      name: "Demo-Veranstaltung",
      title: "Deine Auslagen. Einfach eingereicht.",
      description: "Erste Zeile\nZweite Zeile",
      deadline: "",
      intro: "",
      instructions: "",
      supportEmail: "finance@example.invalid",
      tripStart: "",
      tripEnd: "",
    },
    terms: {
      declaration: "Ich bestätige.",
      privacyText: "# Datenschutz\n\nText",
      travel: "optional",
      mileageRate: "0.30",
      purposeOptions: [],
      fixedPurpose: null,
    },
    draft: { id: "6f6d3e0a-6a5f-4d3b-9d64-1d2d0f6a1c11", token: "token" },
    config: {
      limits: {
        receipt_bytes: 10_000_000,
        submission_bytes: 50_000_000,
        signature_bytes: 1_000_000,
        expenses: 30,
        files_per_expense: 3,
        pdf_pages: 30,
        claim_pages: 100,
      },
      amount_pattern: "\\d{1,9}(?:[,.]\\d{1,2})?",
      max_distance_km: 5000,
      messages: { expense_count: "Bitte lege 1 bis 30 Positionen an.", upload_hint: "PDF, JPG oder PNG" },
      text: {
        total: "Summe",
        expenses_empty_mileage: "Lege eine Auslage an.",
        review_total: "Summe: {amount}",
      },
      locale: "de-DE",
      decimal_separator: ",",
      thousands_separator: ".",
      date_format: "DD.MM.YYYY",
      amount_placeholder: "0,00",
      field_lengths: {
        merchant: 200,
        purpose: 3000,
        receipt_reference: 100,
        route_from: 200,
        route_to: 200,
        vehicle_registration: 20,
      },
    },
    countries: [
      ["DE", "Deutschland"],
      ["AT", "Österreich"],
    ],
    development: false,
    confirmation: true,
    ...overrides,
  };
}

describe("participant pages", () => {
  it("the start page sends participants to the open primary form", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/start": { body: { redirect: "demo" } },
      "/api/v1/public/forms/demo": { body: formPage() },
    });
    const { router } = renderApp("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/f/demo"));
  });

  it("the start page lists no forms", async () => {
    mockApi({ ...meta, "/api/v1/public/start": { body: { redirect: null } } });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Auslagen einreichen" })).toBeInTheDocument();
  });

  it("a form shows its texts, fields and the totals", async () => {
    mockApi({ ...meta, "/api/v1/public/forms/demo": { body: formPage() } });
    renderApp("/f/demo/");
    expect(
      await screen.findByRole("heading", { name: "Deine Auslagen. Einfach eingereicht." }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Vorname Nachname/)).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText(/^Land/)).toHaveValue("DE");
    // The full name fills the account holder until the participant changes it.
    fireEvent.change(screen.getByLabelText(/Vorname Nachname/), { target: { value: "Alex Beispiel" } });
    expect(screen.getByLabelText(/Kontoinhaber/)).toHaveValue("Alex Beispiel");
    fireEvent.click(screen.getByRole("button", { name: "Kilometererstattung" }));
    fireEvent.change(document.querySelector('[data-field="distance_km"]')!, { target: { value: "100" } });
    expect(document.getElementById("totals")!.textContent).toContain("30,00");
    expect(screen.getByText("Datenschutz", { selector: "a" })).toBeInTheDocument();
    expect(screen.getByText("finance@example.invalid")).toBeInTheDocument();
  });

  it("review needs an expense first, and says so", async () => {
    mockApi({ ...meta, "/api/v1/public/forms/demo": { body: formPage() } });
    renderApp("/f/demo");
    fireEvent.click(await screen.findByRole("button", { name: /Angaben prüfen/ }));
    await waitFor(() =>
      expect(document.getElementById("form-error")).toHaveTextContent("Bitte lege 1 bis 30 Positionen an."),
    );
    expect(document.getElementById("form-error")).toHaveAttribute("role", "alert");
    expect(document.getElementById("review-panel")).not.toBeVisible();
  });

  it("a fixed purpose is text, several are choices", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/forms/demo": {
        body: formPage({
          terms: { ...formPage().terms, purposeOptions: ["Werkstatt"], fixedPurpose: "Werkstatt" },
        }),
      },
    });
    renderApp("/f/demo");
    expect(await screen.findByText("Werkstatt")).toBeInTheDocument();
    expect(document.querySelector('#id_purpose[type="hidden"]')).toHaveValue("Werkstatt");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("a closed form names itself only when it is published", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/forms/demo": {
        status: 403,
        body: { state: "closed", name: "Demo-Veranstaltung", message: null, supportEmail: null },
      },
    });
    renderApp("/f/demo");
    expect(await screen.findByRole("heading", { name: "Formular geschlossen" })).toBeInTheDocument();
    expect(screen.getByText("Demo-Veranstaltung")).toBeInTheDocument();
  });

  it("an unknown form is not found", async () => {
    mockApi(meta);
    renderApp("/f/missing");
    expect(await screen.findByText("Das Formular wurde nicht gefunden.")).toBeInTheDocument();
  });

  it("the received page shows the reference and the outcome", async () => {
    const claim: ReceivedAnswer = {
      reference: "Erst/2026-10-21/demo/beispiel/000001",
      state: "delivered",
      final: true,
      form: { name: "Demo-Veranstaltung", supportEmail: "finance@example.invalid" },
    };
    mockApi({ ...meta, "/api/v1/public/received/c1": { body: claim } });
    renderApp("/received/c1/");
    expect(await screen.findByText(claim.reference)).toBeInTheDocument();
    expect(document.getElementById("processing-status")).toHaveTextContent(
      "Dein Antrag wurde an Finance übermittelt.",
    );
  });

  // Review I11: the purpose choice and both consents are required for assistive technology too.
  it("the purpose choice and the consents are required and carry their errors", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/forms/demo": {
        body: formPage({ terms: { ...formPage().terms, purposeOptions: ["Werkstatt", "Tagung"] } }),
      },
    });
    renderApp("/f/demo");
    const group = await screen.findByRole("radiogroup");
    expect(group).toHaveAttribute("aria-required", "true");
    expect(group).toHaveAttribute("aria-describedby", "error-purpose");
    expect(group).toHaveAccessibleName(/Anlass/);
    for (const id of ["declaration", "privacy_acknowledged"])
      expect(document.getElementById(id)).toHaveAttribute("aria-required", "true");
  });

  // Review I6: a link inside the app asks before it drops entries, as the browser did for 0.4's links.
  it("a link inside the app asks before leaving a form with entries", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/forms/demo": { body: formPage() },
      "/api/v1/public/privacy": { body: { notice: null } },
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { router } = renderApp("/f/demo");
    fireEvent.change(await screen.findByLabelText(/Vorname Nachname/), {
      target: { value: "Alex Beispiel" },
    });
    fireEvent.click(screen.getByText("Datenschutz", { selector: "a" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe("/f/demo");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("Datenschutz", { selector: "a" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/datenschutz"));
  });

  // Review I5: a status request that timed out does not fail the polls after it.
  it("the received page recovers after a status request timed out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const claim: ReceivedAnswer = {
        reference: "Erst/2026-10-21/demo/beispiel/000001",
        state: "processing",
        final: false,
        form: { name: "Demo-Veranstaltung", supportEmail: "finance@example.invalid" },
      };
      let polls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
          if (url.pathname === "/api/v1/meta") return json(testMeta());
          polls += 1;
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          // The first poll hangs until its deadline aborts it.
          if (polls === 2)
            return new Promise<Response>((_, reject) =>
              signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
            );
          return json(polls === 1 ? claim : { ...claim, state: "delivered", final: true });
        }),
      );
      renderApp("/received/c1/");
      expect(await screen.findByText(claim.reference)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3_000 + 15_000 + 500);
      await waitFor(() =>
        expect(document.getElementById("processing-status")).toHaveTextContent("nicht erreichbar"),
      );
      await vi.advanceTimersByTimeAsync(7_000);
      await waitFor(() =>
        expect(document.getElementById("processing-status")).toHaveTextContent(
          "Dein Antrag wurde an Finance übermittelt.",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("the privacy page shows the notice with its headings and version", async () => {
    mockApi({
      ...meta,
      "/api/v1/public/privacy": {
        body: {
          notice: { text: "# Hinweis\n\nErster Absatz", version: 2, createdAt: "", date: "01.11.2026" },
        },
      },
    });
    renderApp("/datenschutz/");
    expect(await screen.findByRole("heading", { name: "Hinweis" })).toBeInTheDocument();
    expect(screen.getByText("Version 2 vom 01.11.2026")).toBeInTheDocument();
  });
});
