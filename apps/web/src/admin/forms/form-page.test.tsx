import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimList, FormEditor, FormSaved } from "@reimbursements/shared/api/admin";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

/**
 * The form editor saves as one types (tests/browser/admin-form-recovery.cjs
 * and the autosave cases of tests/test_admin.py, on the page's side).
 */
afterEach(() => vi.unstubAllGlobals());

const EDITOR: FormEditor = {
  form: null,
  settings: {
    name: "",
    slug: "",
    primary: false,
    opensAt: { date: "", time: "" },
    closesAt: { date: "", time: "" },
    title: "",
    description: "",
    instructions: "",
    purposeOptions: "",
    tripStart: "",
    tripEnd: "",
    recipient: "finance@example.invalid",
    supportEmail: "ada@example.invalid",
    values: { kst: "", ktr: "" },
  },
  template: {
    id: 1,
    name: "Test-Vorlage",
    travel: "optional",
    fields: [
      { key: "kst", label: "Kostenstelle (KST)", kind: "text", options: [], required: true },
      { key: "ktr", label: "Kostenträger (KTR)", kind: "text", options: [], required: false },
    ],
  },
  recipients: ["finance@example.invalid"],
  canChoosePrimary: true,
  standardTitle: "Deine Auslagen. Einfach eingereicht.",
  standardDescription: "",
  datePattern: "DD.MM.YYYY",
  timezone: "Europe/Berlin",
  invalidValues: [],
};

const saved = (changes: Partial<FormSaved> = {}): FormSaved => ({
  id: 7,
  name: "Werkstatt",
  slug: "werkstatt",
  status: "draft",
  primary: false,
  link: "/f/werkstatt/",
  canDelete: true,
  ...changes,
});

/** The Claims page, where the exit tests leave to: complete, so it renders. */
const CLAIMS: ClaimList = {
  rows: [],
  count: 0,
  page: 1,
  pages: 1,
  forms: [],
  statuses: [],
  dates: { crumbs: [], options: [] },
  canOperate: true,
};

const meta = { "/api/v1/meta": { body: testMeta({ user: ADMIN }) } };
const bodyOf = async (request: Request) =>
  JSON.parse(await request.clone().text()) as Record<string, unknown>;

describe("the form editor", () => {
  it("saves a new form shortly after typing, then keeps editing it at its own address", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/new": { body: EDITOR },
      "POST /api/v1/admin/forms": { status: 201, body: saved() },
      "PUT /api/v1/admin/forms/7": { body: saved({ name: "Werkstatt Herbst" }) },
    });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/forms/new?template=1");
    const name = await screen.findByLabelText(/^Name/);
    expect(screen.getByRole("status")).toHaveTextContent("Changes are saved automatically.");
    await user.type(name, "Werkstatt");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes …");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All changes saved."), {
      timeout: 3000,
    });
    const first = calls.find((call) => call.method === "POST")!;
    const sent = await bodyOf(first);
    expect(sent).toMatchObject({ name: "Werkstatt", slug: "werkstatt", action: "" });
    expect(sent.creationKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/forms/7"));
    // The same editor goes on: what was typed stays, the next save changes the form it made.
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Werkstatt");
    await user.type(screen.getByLabelText(/^Name/), " Herbst");
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true), { timeout: 3000 });
    expect(await bodyOf(calls.find((call) => call.method === "PUT")!)).toMatchObject({
      name: "Werkstatt Herbst",
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("keeps changes after a failed save and sends them again with the same creation key", async () => {
    let fail = true;
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/new": { body: EDITOR },
      "POST /api/v1/admin/forms": () =>
        fail
          ? { status: 503, body: { error: { code: "down", message: "Down" } } }
          : { status: 201, body: saved() },
    });
    const user = userEvent.setup();
    renderApp("/admin/forms/new?template=1");
    await user.type(await screen.findByLabelText(/^Name/), "Werkstatt");
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "Saving failed. Your changes are not saved yet.",
        ),
      { timeout: 3000 },
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Down");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All changes saved."));
    const posts = calls.filter((call) => call.method === "POST");
    const keys = await Promise.all(posts.map(async (call) => (await bodyOf(call)).creationKey));
    expect(new Set(keys).size).toBe(1);
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Werkstatt");
  });

  it("marks the fields publishing needs, and keeps the form a draft", async () => {
    mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: {
          ...EDITOR,
          form: saved(),
          settings: { ...EDITOR.settings, name: "Werkstatt", slug: "werkstatt" },
        },
      },
      "PUT /api/v1/admin/forms/7": {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Please correct the marked fields.",
            fields: { "values.kst": "This field is required.", supportEmail: "This field is required." },
          },
        },
      },
    });
    const user = userEvent.setup();
    renderApp("/admin/forms/7");
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Publishing failed."));
    expect(screen.getByText("Please correct the marked fields.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Kostenstelle/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Contact for questions/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("publishes, then offers to unpublish", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: {
          ...EDITOR,
          form: saved(),
          settings: { ...EDITOR.settings, name: "Werkstatt", slug: "werkstatt" },
        },
      },
      "PUT /api/v1/admin/forms/7": { body: saved({ status: "published", canDelete: false }) },
    });
    const user = userEvent.setup();
    renderApp("/admin/forms/7");
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(await bodyOf(calls.find((call) => call.method === "PUT")!)).toMatchObject({ action: "publish" });
  });

  it("deletes a draft after confirming", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved(), settings: { ...EDITOR.settings, name: "Werkstatt" } },
      },
      "DELETE /api/v1/admin/forms/7": { body: { ok: true } },
      "GET /api/v1/admin/forms": {
        body: { rows: [], count: 0, page: 1, pages: 1, templates: [], canDelete: true },
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/forms/7");
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete draft for good" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/forms"));
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("lets form editors see, not choose, the start page", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
      "GET /api/v1/admin/forms/new": { body: { ...EDITOR, canChoosePrimary: false } },
    });
    renderApp("/admin/forms/new?template=1");
    expect(await screen.findByRole("checkbox", { name: "Start page" })).toBeDisabled();
  });

  it("asks before a link leaves unsaved changes behind, and stays when asked to", async () => {
    mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved(), settings: { ...EDITOR.settings, name: "Werkstatt" } },
      },
      "PUT /api/v1/admin/forms/7": { body: saved() },
    });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/forms/7");
    await user.type(await screen.findByLabelText(/^Name/), " Herbst");
    await user.click(screen.getByRole("link", { name: "Claims" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Leave without saving?")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/admin/forms/7");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(router.state.location.pathname).toBe("/admin/forms/7");
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Werkstatt Herbst");
    // Once everything is saved, the link leaves at once.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All changes saved."), {
      timeout: 3000,
    });
    await user.click(screen.getByRole("link", { name: "Claims" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("sends nothing more once the person left without saving while a save was running", async () => {
    const { calls, fetchMock } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved(), settings: { ...EDITOR.settings, name: "Werkstatt" } },
      },
      "PUT /api/v1/admin/forms/7": { body: saved() },
      "GET /api/v1/admin/claims": { body: CLAIMS },
    });
    // The first save hangs until the person has left.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = fetchMock(input, init);
      if (init?.method === "PUT" && calls.filter((call) => call.method === "PUT").length === 1) await held;
      return answer;
    });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/forms/7");
    await user.type(await screen.findByLabelText(/^Name/), " Herbst");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving …"), { timeout: 3000 });
    await user.type(screen.getByLabelText(/^Name/), " 2026");
    await user.click(screen.getByRole("link", { name: "Claims" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    await waitFor(() => expect(screen.queryByLabelText(/^Name/)).toBeNull());
    release();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("sends nothing more once the exit is confirmed, while the next page still loads", async () => {
    const { calls, fetchMock } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved(), settings: { ...EDITOR.settings, name: "Werkstatt" } },
      },
      "PUT /api/v1/admin/forms/7": { body: saved() },
      "GET /api/v1/admin/claims": { body: CLAIMS },
    });
    // The first save hangs, and so does the next page's session check once the person confirmed.
    let releaseSave!: () => void;
    const heldSave = new Promise<void>((resolve) => (releaseSave = resolve));
    let releasePage!: () => void;
    const heldPage = new Promise<void>((resolve) => (releasePage = resolve));
    let confirmed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = fetchMock(input, init);
      if (init?.method === "PUT" && calls.filter((call) => call.method === "PUT").length === 1)
        await heldSave;
      if (confirmed && String(input).includes("/api/v1/meta")) await heldPage;
      return answer;
    });
    const user = userEvent.setup();
    const { router, queryClient } = renderApp("/admin/forms/7");
    await user.type(await screen.findByLabelText(/^Name/), " Herbst");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving …"), { timeout: 3000 });
    await user.type(screen.getByLabelText(/^Name/), " 2026");
    await user.click(screen.getByRole("link", { name: "Claims" }));
    const dialog = await screen.findByRole("alertdialog");
    // After a minute on the page the session check is stale: the next page asks the server first.
    await queryClient.invalidateQueries({ queryKey: ["meta"], refetchType: "none" });
    confirmed = true;
    await user.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    // The editor is still there while the next page loads; the running save ends now.
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    releaseSave();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    releasePage();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(await screen.findByText("No claims yet")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("stays on the next page when the first save of a new form ends after the exit was confirmed", async () => {
    const { calls, fetchMock } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/new": { body: EDITOR },
      "POST /api/v1/admin/forms": { status: 201, body: saved() },
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved(), settings: { ...EDITOR.settings, name: "Werkstatt" } },
      },
      "GET /api/v1/admin/claims": { body: CLAIMS },
    });
    // The first save hangs, and so does the next page's session check once the person confirmed.
    let releaseSave!: () => void;
    const heldSave = new Promise<void>((resolve) => (releaseSave = resolve));
    let releasePage!: () => void;
    const heldPage = new Promise<void>((resolve) => (releasePage = resolve));
    let confirmed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = fetchMock(input, init);
      if (init?.method === "POST") await heldSave;
      if (confirmed && String(input).includes("/api/v1/meta")) await heldPage;
      return answer;
    });
    const user = userEvent.setup();
    const { router, queryClient } = renderApp("/admin/forms/new?template=1");
    await user.type(await screen.findByLabelText(/^Name/), "Werkstatt");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving …"), { timeout: 3000 });
    await user.click(screen.getByRole("link", { name: "Claims" }));
    const dialog = await screen.findByRole("alertdialog");
    await queryClient.invalidateQueries({ queryKey: ["meta"], refetchType: "none" });
    confirmed = true;
    await user.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    // The new form's address does not take over the exit the person confirmed.
    releaseSave();
    await new Promise((resolve) => setTimeout(resolve, 500));
    releasePage();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(await screen.findByText("No claims yet")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(router.state.location.pathname).toBe("/admin/claims");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("reads the form again when it is opened again, so a later save keeps the earlier one", async () => {
    const base = { ...EDITOR.settings, name: "Werkstatt", slug: "werkstatt" };
    const { calls } = mockApi({
      ...meta,
      // The server's state: the title the first save stored.
      "GET /api/v1/admin/forms/7": () => ({
        body: {
          ...EDITOR,
          form: saved(),
          settings: calls.some((call) => call.method === "PUT") ? { ...base, title: "Neu" } : base,
        },
      }),
      "PUT /api/v1/admin/forms/7": { body: saved() },
      "GET /api/v1/admin/forms": {
        body: { rows: [], count: 0, page: 1, pages: 1, templates: [], canDelete: true },
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp("/admin/forms/7");
    await user.type(await screen.findByLabelText(/^Title/), "Neu");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All changes saved."), {
      timeout: 3000,
    });
    await router.navigate({ to: "/admin/forms" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/forms"));
    await router.navigate({ to: "/admin/forms/$formId", params: { formId: "7" } });
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Neu");
    await user.type(screen.getByLabelText(/^Name/), " Herbst");
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2), {
      timeout: 3000,
    });
    expect(await bodyOf(calls.filter((call) => call.method === "PUT")[1]!)).toMatchObject({
      name: "Werkstatt Herbst",
      title: "Neu",
    });
  });

  it("sends the start page only when it was changed", async () => {
    const { calls } = mockApi({
      ...meta,
      "GET /api/v1/admin/forms/7": {
        body: { ...EDITOR, form: saved({ primary: true }), settings: { ...EDITOR.settings, primary: true } },
      },
      "PUT /api/v1/admin/forms/7": { body: saved({ primary: true }) },
    });
    const user = userEvent.setup();
    renderApp("/admin/forms/7");
    await user.type(await screen.findByLabelText(/^Name/), "Werkstatt");
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true), { timeout: 3000 });
    expect(await bodyOf(calls.find((call) => call.method === "PUT")!)).not.toHaveProperty("primary");
    await user.click(screen.getByRole("checkbox", { name: "Start page" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2), {
      timeout: 3000,
    });
    expect(await bodyOf(calls.filter((call) => call.method === "PUT")[1]!)).toMatchObject({ primary: false });
  });
});
