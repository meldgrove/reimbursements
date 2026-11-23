/**
 * The participant API: the start page, the form page, privacy and received
 * pages, draft limits and races (the participant views of tests/test_forms.py,
 * tests/test_draft_limits.py and tests/test_concurrency.py).
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import {
  claims,
  draftAdmissions,
  drafts,
  formOwners,
  forms,
  jobs,
  privacyNotices,
  sessions,
} from "../db/schema";
import { createForm, template } from "../test/fixtures";
import { CookieJar, createUser, request, signInWithTestHeader } from "../test/helpers";
import { freshIntake, intakeSettings, openForm, post, prepared } from "../test/intake";
import { allocateReference } from "../services/references";
import { cleanup } from "../services/retention";
import { runJobs } from "../worker";

async function participantSessions() {
  return getDb().$count(sessions, eq(sessions.kind, "participant"));
}

describe("start page", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it("does not list forms", async () => {
    const form = await createForm();
    const response = await request("GET", "/api/v1/public/start");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ redirect: null });
    expect(response.text).not.toContain(form.name);
  });

  it("redirects to the open primary form", async () => {
    const form = await createForm({ primary: true });
    expect((await request("GET", "/api/v1/public/start")).body.redirect).toBe("test");
    await getDb().update(forms).set({ status: "draft" }).where(eq(forms.id, form.id));
    expect((await request("GET", "/api/v1/public/start")).body.redirect).toBeNull();
    // A new start page takes over from the previous one.
    await getDb().update(forms).set({ primary: false }).where(eq(forms.id, form.id));
    await getDb()
      .insert(forms)
      .values({
        templateId: (await template()).id,
        slug: "allgemein",
        name: "Allgemein",
        fieldValues: form.fieldValues,
        recipient: form.recipient,
        supportEmail: form.supportEmail,
        status: "published",
        primary: true,
      });
    expect((await request("GET", "/api/v1/public/start")).body.redirect).toBe("allgemein");
  });

  it.each(["recipient", "privacy_notice"])(
    "skips a primary form that cannot accept claims: %s",
    async (unavailable) => {
      await createForm({ primary: true });
      if (unavailable === "recipient")
        intakeSettings({ APPROVED_DELIVERY_RECIPIENTS: ["other@example.invalid"] });
      else await getDb().delete(privacyNotices);
      expect((await openForm(new CookieJar())).status).toBe(503);
      expect((await request("GET", "/api/v1/public/start")).body.redirect).toBeNull();
    },
  );
});

describe("form page", () => {
  let restore: () => void;
  beforeEach(async () => {
    await freshIntake();
    restore = signInWithTestHeader();
  });
  afterEach(() => restore());

  it("offers the form, its terms and a draft", async () => {
    await createForm({
      closesAt: new Date("2099-12-31T22:30:00Z"),
      instructions: "Bitte Belege bereithalten.",
    });
    const page = await openForm(new CookieJar());
    expect(page.status).toBe(200);
    expect(page.body.state).toBe("open");
    expect(page.body.form).toMatchObject({
      slug: "test",
      name: "Test Workshop",
      title: "Deine Auslagen. Einfach eingereicht.",
      deadline: "Einreichen bis 31.12.2099, 23:30 CET",
      instructions: "Bitte Belege bereithalten.",
      supportEmail: "finance@example.invalid",
    });
    expect(page.body.terms).toMatchObject({ travel: "optional", mileageRate: "0.30", purposeOptions: [] });
    expect(page.body.terms.privacyText).toBeTruthy();
    expect(page.body.draft.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.body.config.date_format).toBe("DD.MM.YYYY");
    expect(page.body.config.amount_placeholder).toBe("0,00");
    expect(page.body.config.mileage_rate).toBeUndefined();
    expect(page.body.config.messages.upload_hint).toContain("50 MB insgesamt");
    expect(page.body.countries).toContainEqual(["DE", "Deutschland"]);
  });

  it("is unknown for a slug without a form", async () => {
    expect((await openForm(new CookieJar(), "missing")).status).toBe(404);
  });

  it.each(["draft", "archived"])(
    "an unpublished form's name is private, but owners can preview it: %s",
    async (status) => {
      const form = await createForm({ name: "Private unpublished form name", status });
      let page = await openForm(new CookieJar());
      expect(page.status).toBe(403);
      expect(page.text).not.toContain(form.name);
      const editor = await createUser("editor-subject", ["Formular-Editoren"]);
      page = await request("GET", "/api/v1/public/forms/test", { user: editor, jar: new CookieJar() });
      expect(page.status).toBe(403);
      expect(page.text).not.toContain(form.name);
      await getDb().insert(formOwners).values({ formId: form.id, userId: editor.id });
      page = await request("GET", "/api/v1/public/forms/test", { user: editor, jar: new CookieJar() });
      expect(page.status).toBe(200);
      expect(page.body.state).toBe("preview");
      expect(page.body.draft).toBeNull();
      expect(await getDb().$count(drafts)).toBe(0);
    },
  );

  it("names a closed published form", async () => {
    await createForm({ closesAt: new Date(Date.now() - 1000) });
    const page = await openForm(new CookieJar());
    expect(page.status).toBe(403);
    expect(page.body).toMatchObject({ state: "closed", name: "Test Workshop", message: null });
  });

  it("answers in English when that is the app language", async () => {
    await createForm();
    const { saveSettings } = await import("../services/app-settings");
    await saveSettings({ language: "en", numberFormat: "us" });
    const page = await openForm(new CookieJar());
    expect(page.body.form.title).toBe("Your expenses. Simply submitted.");
    expect(page.body.config.locale).toBe("en-GB");
    expect(page.body.config.amount_placeholder).toBe("0.00");
    expect(page.body.config.text.submit).toBe("Submit claim →");
    expect(page.body.countries).toContainEqual(["DE", "Germany"]);
  });

  it("serves the privacy notice", async () => {
    await createForm();
    const response = await request("GET", "/api/v1/public/privacy");
    const [notice] = await getDb().select().from(privacyNotices);
    expect(response.body.notice.text).toBe(notice!.text);
    expect(response.body.notice.version).toBe(notice!.version);
    await getDb().delete(privacyNotices);
    expect((await request("GET", "/api/v1/public/privacy")).body).toEqual({ notice: null });
  });
});

describe("received page", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it("shows the participant their claim's outcome", async () => {
    const current = await prepared();
    const response = await post(current);
    const received = await request("GET", `/api/v1/public/received/${response.body.claimId}`, {
      jar: current.jar,
    });
    expect(received.status).toBe(200);
    expect(received.body).toEqual({
      reference: response.body.reference,
      state: "processing",
      final: false,
      form: { name: "Test Workshop", supportEmail: "finance@example.invalid" },
    });
    expect((await request("GET", "/api/v1/public/received/not-a-uuid", { jar: current.jar })).status).toBe(
      404,
    );
  });
});

describe("draft limits", () => {
  beforeEach(async () => {
    await freshIntake();
    await createForm();
  });

  it("cookie resets cannot exhaust the draft capacity", async () => {
    intakeSettings({ MAX_DRAFTS_PER_NETWORK: 3 });
    const jars = [new CookieJar(), new CookieJar(), new CookieJar(), new CookieJar()];
    const statuses = [];
    for (const jar of jars) statuses.push((await openForm(jar)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(await getDb().$count(drafts)).toBe(3);
    expect(await participantSessions()).toBe(3);
    expect((await getDb().select().from(draftAdmissions))[0]!.count).toBe(3);
    // Existing work is accessible after the new-draft budget is exhausted.
    expect((await openForm(jars[0]!)).status).toBe(200);
    expect((await openForm(new CookieJar(), "test", { remoteAddress: "192.0.2.5" })).status).toBe(200);
    // A direct caller cannot bypass the limit by inventing a forwarded address.
    expect(
      (await openForm(new CookieJar(), "test", { headers: { "x-forwarded-for": "192.0.2.6" } })).status,
    ).toBe(429);
  });

  it("an expired budget resets and old keys are cleaned", async () => {
    intakeSettings({ MAX_DRAFTS_PER_NETWORK: 1 });
    expect((await openForm(new CookieJar())).status).toBe(200);
    await getDb()
      .update(draftAdmissions)
      .set({ windowStart: new Date(Date.now() - 25 * 3600 * 1000) });
    expect((await openForm(new CookieJar())).status).toBe(200);
    expect((await getDb().select().from(draftAdmissions))[0]!.count).toBe(1);
    await getDb()
      .update(draftAdmissions)
      .set({ windowStart: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
    await cleanup({ execute: true });
    expect(await getDb().$count(draftAdmissions)).toBe(0);
  });

  it("full capacity rejects before creating another session", async () => {
    intakeSettings({ MAX_ACTIVE_DRAFTS: 1 });
    expect((await openForm(new CookieJar())).status).toBe(200);
    expect((await openForm(new CookieJar())).status).toBe(503);
    expect(await participantSessions()).toBe(1);
  });

  it("the worker removes expired sessions and keeps active ones", async () => {
    const [expired, active] = [new CookieJar(), new CookieJar()];
    await openForm(expired);
    await openForm(active);
    await getDb()
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.id, (await getDb().select().from(sessions))[0]!.id));
    await cleanup({ execute: false });
    expect(await participantSessions()).toBe(2);
    await runJobs({ once: true });
    expect(await participantSessions()).toBe(1);
  });
});

describe("races", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it("racing submissions create one claim", async () => {
    const current = await prepared();
    const results = await Promise.all([post(current), post(current)]);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await getDb().$count(claims)).toBe(1);
    expect(await getDb().$count(jobs, eq(jobs.kind, "render"))).toBe(1);
  });

  it("concurrent fresh sessions share one creation budget", async () => {
    await createForm();
    intakeSettings({ MAX_DRAFTS_PER_NETWORK: 1 });
    const statuses = await Promise.all(
      [0, 1, 2, 3].map(() => openForm(new CookieJar()).then((page) => page.status)),
    );
    expect(statuses.sort()).toEqual([200, 429, 429, 429]);
    expect(await getDb().$count(drafts)).toBe(1);
    expect((await getDb().select().from(draftAdmissions))[0]!.count).toBe(1);
  });

  it("concurrent references get distinct numbers even on first use", async () => {
    const references = await Promise.all(
      [0, 1, 2, 3].map(() => allocateReference("werkstatt", "Alex Beispiel", new Date())),
    );
    expect(new Set(references).size).toBe(4);
    expect(references.map((reference) => reference.split("/").at(-1)).sort()).toEqual([
      "000001",
      "000002",
      "000003",
      "000004",
    ]);
  });
});
