import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimDetail, ClaimList, ClaimSummary } from "@reimbursements/shared/api/admin";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

/** The operator actions of a claim: process again, archive, delete (tests/test_admin.py, on the page's side). */
afterEach(() => vi.unstubAllGlobals());

const ID = "0f8b4c8e-9a52-4d0e-8b4a-0f6d7c3d2e1a";
const STATUS = { code: "received", label: "Received", tone: "secondary" };

const CLAIM: ClaimDetail = {
  id: ID,
  reference: ID,
  form: "Test Workshop",
  submittedAt: "20.11.2026, 10:00",
  fullName: "Alex Beispiel",
  email: "participant@example.invalid",
  total: "12,50",
  status: STATUS,
  archived: false,
  error: "",
  archivedAt: "",
  pdfRemovedAt: "",
  contentDue: "",
  overdue: false,
  operations: [
    {
      id: 1,
      when: "21.11.2026, 09:00",
      action: "Processed again",
      actor: "admin@example.invalid",
      reason: "Sandbox",
    },
  ],
  canOperate: true,
};

const SUMMARY: ClaimSummary = {
  id: ID,
  reference: ID,
  form: "Test Workshop",
  submittedOn: "20.11.2026",
  fullName: "Alex Beispiel",
  status: STATUS,
  archived: false,
};

const LIST: ClaimList = {
  rows: [
    {
      id: ID,
      reference: ID.slice(0, 8),
      form: "Test Workshop",
      submittedAt: "20.11.2026, 10:00",
      fullName: "Alex Beispiel",
      email: "participant@example.invalid",
      total: "12,50",
      status: STATUS,
      archived: false,
      overdue: true,
    },
  ],
  count: 1,
  page: 1,
  pages: 1,
  forms: [{ value: "1", label: "Test Workshop" }],
  statuses: [{ value: "received", label: "Received" }],
  dates: { crumbs: [], options: [{ value: "2026", label: "2026" }] },
  canOperate: true,
};

const meta = { "/api/v1/meta": { body: testMeta({ user: ADMIN }) } };
const bodyOf = async (request: Request) =>
  JSON.parse(await request.clone().text()) as Record<string, unknown>;

describe("a claim", () => {
  it("shows template admins its actions and the logged ones", async () => {
    mockApi({ ...meta, [`GET /api/v1/admin/claims/${ID}`]: { body: CLAIM } });
    renderApp(`/admin/claims/${ID}`);
    expect(await screen.findByText("Alex Beispiel")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Process again" })).toHaveAttribute(
      "href",
      `/admin/claims/${ID}/retry`,
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Delete" })).toHaveAttribute(
      "href",
      `/admin/claims/delete?ids=${ID}`,
    );
    expect(screen.getByText("Processed again")).toBeInTheDocument();
  });

  it("shows form editors no actions", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
      [`GET /api/v1/admin/claims/${ID}`]: { body: { ...CLAIM, canOperate: false } },
    });
    renderApp(`/admin/claims/${ID}`);
    expect(await screen.findByText("Alex Beispiel")).toBeInTheDocument();
    expect(screen.queryByText("Process again")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("asks before archiving an overdue claim, as it is then deleted", async () => {
    const { calls } = mockApi({
      ...meta,
      [`GET /api/v1/admin/claims/${ID}`]: { body: CLAIM },
      [`POST /api/v1/admin/claims/${ID}/archive`]: {
        body: { confirm: true, overdue: [SUMMARY], selected: 1, retentionDays: 90 },
      },
    });
    const user = userEvent.setup();
    renderApp(`/admin/claims/${ID}`);
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Archive claim?")).toBeInTheDocument();
    expect(within(dialog).getByText("The claim is deleted for good within minutes.")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Beispiel", { exact: false })).toBeInTheDocument();
    const posts = () => calls.filter((call) => call.method === "POST");
    expect(await bodyOf(posts()[0]!)).toEqual({ confirm: false });
    await user.click(within(dialog).getByRole("button", { name: "Archive claim" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(await bodyOf(posts()[1]!)).toEqual({ confirm: true });
  });
});

describe("the claims list", () => {
  it("lets template admins archive selected claims", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/claims": { body: LIST },
      "POST /api/v1/admin/claims/archive": {
        body: { confirm: false, changed: 1, message: "1 claim was archived." },
      },
    });
    const user = userEvent.setup();
    renderApp("/admin/claims");
    expect(await screen.findByText("Overdue")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: `Select claim ${ID.slice(0, 8)}` }));
    await user.click(screen.getByRole("button", { name: "Archive selected claims" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(await bodyOf(calls.find((call) => call.method === "POST")!)).toEqual({
      ids: [ID],
      confirm: false,
    });
    expect(await screen.findByText("1 claim was archived.")).toBeInTheDocument();
  });

  it("filters by status through the address", async () => {
    const { calls } = mockApi({ ...meta, "GET /api/v1/admin/claims": { body: LIST } });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/claims");
    await screen.findByText("Alex Beispiel");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "received");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ status: "received" }));
    await waitFor(() =>
      expect(calls.some((call) => new URL(call.url).searchParams.get("status") === "received")).toBe(true),
    );
  });

  it("offers form editors no bulk actions", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
      "GET /api/v1/admin/claims": { body: { ...LIST, canOperate: false } },
    });
    renderApp("/admin/claims");
    expect(await screen.findByText("Alex Beispiel")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("deleting claims", () => {
  it("needs a reason, then deletes and goes back to the list", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/claims/deletion": { body: { rows: [{ ...SUMMARY, sent: false }] } },
      "POST /api/v1/admin/claims/delete": (request) =>
        request.headers.get("content-type")
          ? {
              body: {
                deleted: 1,
                resuming: 0,
                refused: [],
                messages: [{ tone: "success", text: "The claim was deleted." }],
              },
            }
          : { status: 400, body: {} },
      "GET /api/v1/admin/claims": { body: { ...LIST, rows: [], count: 0 } },
    });
    const user = userEvent.setup();
    const { router } = renderApp(`/admin/claims/delete?ids=${ID}`);
    expect(await screen.findByText("Not yet sent to Finance")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Reason/), "Testeinreichung");
    await user.click(screen.getByRole("button", { name: "Delete claim for good" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(await bodyOf(calls.find((call) => call.method === "POST")!)).toEqual({
      ids: [ID],
      reason: "Testeinreichung",
    });
  });

  it("says why a deletion was refused", async () => {
    mockApi({
      ...meta,
      "GET /api/v1/admin/claims/deletion": { body: { rows: [{ ...SUMMARY, sent: true }] } },
      "POST /api/v1/admin/claims/delete": {
        status: 409,
        body: {
          deleted: 0,
          resuming: 0,
          refused: [{ reference: ID, message: "The claim is being processed or sent right now." }],
          messages: [{ tone: "error", text: "The claim is being processed or sent right now." }],
        },
      },
    });
    const user = userEvent.setup();
    renderApp(`/admin/claims/delete?ids=${ID}`);
    expect(await screen.findByText("Already sent to Finance")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Reason/), "Test");
    await user.click(screen.getByRole("button", { name: "Delete claim for good" }));
    expect(await screen.findByText("The claim is being processed or sent right now.")).toBeInTheDocument();
  });
});

describe("processing a claim again", () => {
  it("asks for the acknowledgment of a duplicate", async () => {
    const { calls } = mockApi({
      ...meta,
      [`GET /api/v1/admin/claims/${ID}/retry`]: {
        body: { claim: SUMMARY, plan: { action: "resend", duplicateRisk: true }, refused: "" },
      },
      [`POST /api/v1/admin/claims/${ID}/retry`]: {
        body: { ok: true, message: "Processing has started again." },
      },
      [`GET /api/v1/admin/claims/${ID}`]: { body: CLAIM },
    });
    const user = userEvent.setup();
    const { router } = renderApp(`/admin/claims/${ID}/retry`);
    expect(await screen.findByText("Duplicate delivery possible")).toBeInTheDocument();
    expect(screen.getByText("The PDF is sent to the receiving inbox again.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Reason/), "Das Postfach hat nichts erhalten");
    await user.click(
      screen.getByRole("checkbox", { name: /accept that Finance may receive the claim twice/ }),
    );
    await user.click(screen.getByRole("button", { name: "Process again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/claims/${ID}`));
    expect(await bodyOf(calls.find((call) => call.method === "POST")!)).toEqual({
      reason: "Das Postfach hat nichts erhalten",
      acknowledgeDuplicateRisk: true,
    });
  });

  it("says when it is not possible", async () => {
    mockApi({
      ...meta,
      [`GET /api/v1/admin/claims/${ID}/retry`]: {
        body: { claim: SUMMARY, plan: null, refused: "This claim is already being processed." },
      },
    });
    renderApp(`/admin/claims/${ID}/retry`);
    expect(await screen.findByText("This claim is already being processed.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Reason/)).toBeNull();
  });
});
