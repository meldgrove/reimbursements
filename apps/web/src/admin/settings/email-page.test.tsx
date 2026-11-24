import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSecretState, EmailSettingsPage } from "@reimbursements/shared/api/admin";
import { ADMIN, mockApi, renderApp, testMeta } from "@/test-utils";

/**
 * Admin › Email as admins see it: the page side of tests/test_email_settings.py and the
 * sidebar case of tests/test_admin.py (the server's rules are in
 * apps/server/src/modules/admin/email.int.test.ts).
 */
afterEach(() => vi.unstubAllGlobals());

const URL = "/api/v1/admin/settings/email";
const TEST_URL = "/api/v1/admin/settings/email/test";
const NOTHING: EmailSecretState = {
  saved: false,
  unreadable: false,
  deletable: false,
  placeholder: "",
};
const SAVED: EmailSecretState = {
  ...NOTHING,
  saved: true,
  deletable: true,
  placeholder: "Saved · type a new one to replace it",
};

function emailPage(overrides: Partial<EmailSettingsPage> = {}): EmailSettingsPage {
  return {
    settings: {
      provider: "",
      fromAddress: "",
      replyToAddress: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecurity: "starttls",
      smtpUsername: "",
      confirmationEnabled: true,
      confirmation: {
        de: { subject: "Eingangsbestätigung: Erstattungsantrag {reference}", body: "Hallo {name},\n" },
        en: { subject: "Confirmation of receipt: reimbursement claim {reference}", body: "Hello {name},\n" },
      },
    },
    secrets: { mailersendToken: NOTHING, webhookSecret: NOTHING, smtpPassword: NOTHING },
    environmentNote: "",
    status: {
      state: "not_set_up",
      label: "Not set up",
      text: "Forms take no claims until email is set up. Missing: a provider, a sender address, a reply address for Finance.",
      warning: "",
      unreadable: "",
    },
    webhook: {
      url: "https://reimbursements.example.invalid/webhooks/mailersend/",
      receivedAt: null,
      text: "In MailerSend, create a webhook for https://reimbursements.example.invalid/webhooks/mailersend/ with the events sent, delivered, deferred, soft bounced, hard bounced and suppressed, and enter its signing secret here. No signed event has arrived yet.",
    },
    choices: {
      providers: [
        { value: "", label: "Not set up" },
        { value: "mailersend", label: "MailerSend" },
        { value: "smtp", label: "SMTP server" },
      ],
      securities: [
        { value: "starttls", label: "STARTTLS (usually port 587)" },
        { value: "tls", label: "TLS (usually port 465)" },
        { value: "none", label: "None (only for a relay in a trusted network)" },
      ],
      languages: [
        { value: "de", label: "Deutsch" },
        { value: "en", label: "English" },
      ],
    },
    placeholders: [
      { name: "name", description: "the participant's name" },
      { name: "reference", description: "the claim's reference" },
    ],
    testRecipient: ADMIN.email,
    ...overrides,
  };
}

const meta = { "/api/v1/meta": { body: testMeta({ user: ADMIN }) } };

async function openPage() {
  const view = renderApp("/admin/email");
  await screen.findByRole("heading", { name: "Email", level: 1 });
  return view;
}

describe("Admin › Email", () => {
  it("is in the Admin group between General and Appearance, without a key", async () => {
    mockApi({ ...meta, [`GET ${URL}`]: { body: emailPage() } });
    await openPage();
    const sidebar = screen.getAllByRole("link").map((link) => link.textContent?.trim());
    const general = sidebar.indexOf("General");
    expect(sidebar.slice(general, general + 3)).toEqual(["General", "Email", "Appearance"]);
  });

  it("is only for template admins", async () => {
    mockApi({
      "/api/v1/meta": {
        body: testMeta({ user: { ...ADMIN, isTemplateAdmin: false, roles: ["Formular-Editoren"] } }),
      },
    });
    const { router } = renderApp("/admin/email");
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/claims"));
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("lets admins enter a MailerSend token that is never shown again", async () => {
    const saved = emailPage({
      settings: {
        ...emailPage().settings,
        provider: "mailersend",
        fromAddress: "no-reply@example.invalid",
        replyToAddress: "finance@example.invalid",
      },
      secrets: { mailersendToken: SAVED, webhookSecret: SAVED, smtpPassword: NOTHING },
      status: {
        state: "ready",
        label: "Ready",
        text: "Sends with MailerSend from no-reply@example.invalid.",
        warning: "",
        unreadable: "",
      },
      message: "The email settings were saved.",
    });
    const { calls } = mockApi({
      ...meta,
      [`GET ${URL}`]: { body: emailPage() },
      [`PUT ${URL}`]: { body: saved },
    });
    const user = userEvent.setup();
    await openPage();
    const status = screen.getByTestId("email-status");
    expect(status).toHaveTextContent("Not set up");
    expect(status).toHaveTextContent("Forms take no claims until email is set up");
    // Only the chosen provider's settings show (admin-email.js).
    expect(screen.queryByRole("heading", { name: "MailerSend" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SMTP server" })).toBeNull();

    await user.selectOptions(screen.getByLabelText("Send email with"), "mailersend");
    expect(screen.getByRole("heading", { name: "MailerSend" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "SMTP server" })).toBeNull();
    expect(screen.getByText("https://reimbursements.example.invalid/webhooks/mailersend/").tagName).toBe(
      "CODE",
    );
    await user.type(screen.getByLabelText("Sender address"), "no-reply@example.invalid");
    await user.type(screen.getByLabelText("Reply address for Finance"), "finance@example.invalid");
    const token = screen.getByLabelText("API token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "new-password");
    await user.type(token, "mlsn.synthetic-token");
    await user.type(screen.getByLabelText("Webhook signing secret"), "whsec");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The email settings were saved.")).toBeInTheDocument();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(await put.json()).toMatchObject({
      provider: "mailersend",
      fromAddress: "no-reply@example.invalid",
      replyToAddress: "finance@example.invalid",
      mailersendToken: "mlsn.synthetic-token",
      webhookSecret: "whsec",
      smtpPassword: "",
      deleteMailersendToken: false,
      confirmationEnabled: true,
    });
    // The saved secrets are never shown again: empty fields with a placeholder.
    expect(screen.getByTestId("email-status")).toHaveTextContent(
      "Sends with MailerSend from no-reply@example.invalid.",
    );
    expect(screen.getByLabelText("API token")).toHaveValue("");
    expect(screen.getByLabelText("API token")).toHaveAttribute(
      "placeholder",
      "Saved · type a new one to replace it",
    );
    expect(screen.queryByDisplayValue("mlsn.synthetic-token")).toBeNull();
    expect(screen.getByLabelText("Delete the saved signing secret")).not.toBeChecked();
  });

  it("shows why the chosen provider's settings are not complete", async () => {
    mockApi({
      ...meta,
      [`GET ${URL}`]: { body: emailPage({ settings: { ...emailPage().settings, provider: "smtp" } }) },
      [`PUT ${URL}`]: {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Please correct the errors below.",
            fields: {
              smtpHost: "Enter the SMTP server.",
              smtpPassword: "Enter the password for this username.",
              "confirmation.de.subject":
                "{referenz} is not a placeholder. Use {name}, {form}, {reference}, {payment_timing}, {support}, {app_name}.",
            },
          },
        },
      },
    });
    const user = userEvent.setup();
    await openPage();
    const subject = screen.getByLabelText("Subject (Deutsch)");
    await user.clear(subject);
    await user.type(subject, "Eingang {{referenz}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Please correct the errors below.")).toBeInTheDocument();
    expect(screen.getByLabelText("Server")).toHaveAccessibleDescription(
      expect.stringContaining("Enter the SMTP server."),
    );
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Enter the password for this username.",
    );
    expect(subject).toHaveAccessibleDescription(expect.stringContaining("{referenz} is not a placeholder."));
  });

  it("refuses entering and deleting a secret at once, under the delete box", async () => {
    mockApi({
      ...meta,
      [`GET ${URL}`]: {
        body: emailPage({
          settings: { ...emailPage().settings, provider: "smtp", smtpHost: "smtp.example.invalid" },
          secrets: { mailersendToken: NOTHING, webhookSecret: NOTHING, smtpPassword: SAVED },
        }),
      },
      [`PUT ${URL}`]: {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Please correct the errors below.",
            fields: { deleteSmtpPassword: "Delete it or enter a new one, not both." },
          },
        },
      },
    });
    const user = userEvent.setup();
    await openPage();
    await user.type(screen.getByLabelText("Password"), "second");
    await user.click(screen.getByLabelText("Delete the saved password"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Delete it or enter a new one, not both.")).toBeInTheDocument();
  });

  it("names variables of earlier versions still set, and leaves every field open", async () => {
    const note =
      "MAILERSEND_API_TOKEN and MAIL_FROM_ADDRESS are still set in the environment. The app no longer reads them: this page holds the setting. Delete them from .env once a rollback to 0.5.0 or older is no longer planned and compose.yaml is no longer 0.4's, which requires the email variables.";
    mockApi({
      ...meta,
      [`GET ${URL}`]: {
        body: emailPage({
          settings: { ...emailPage().settings, provider: "mailersend", fromAddress: "kim@example.invalid" },
          secrets: { mailersendToken: SAVED, webhookSecret: NOTHING, smtpPassword: NOTHING },
          environmentNote: note,
        }),
      },
    });
    await openPage();
    expect(screen.getByTestId("environment-note")).toHaveTextContent(note);
    expect(screen.getByLabelText("Send email with")).toBeEnabled();
    expect(screen.getByLabelText("Sender address")).toBeEnabled();
    expect(screen.getByLabelText("API token")).toBeEnabled();
    expect(screen.getByLabelText("Delete the saved API token")).toBeInTheDocument();
  });

  it("says what MailerSend misses without a signing secret, and that a secret no longer opens", async () => {
    mockApi({
      ...meta,
      [`GET ${URL}`]: {
        body: emailPage({
          settings: { ...emailPage().settings, provider: "mailersend" },
          secrets: {
            mailersendToken: {
              ...SAVED,
              unreadable: true,
              placeholder: "Saved, but can no longer be read: enter it again",
            },
            webhookSecret: NOTHING,
            smtpPassword: NOTHING,
          },
          status: {
            state: "not_set_up",
            label: "Not set up",
            text: "Forms take no claims until email is set up. Missing: the MailerSend API token.",
            warning:
              "Without a webhook signing secret, only reconcile-deliveries learns whether emails were delivered.",
            unreadable: "Saved but can no longer be read: api token. Enter it again.",
          },
          webhook: {
            ...emailPage().webhook,
            receivedAt: "23.11.2026 10:00",
            text: "In MailerSend, create a webhook for https://reimbursements.example.invalid/webhooks/mailersend/ with the events sent, delivered, deferred, soft bounced, hard bounced and suppressed, and enter its signing secret here. Last signed event: 23.11.2026 10:00.",
          },
        }),
      },
    });
    await openPage();
    const status = screen.getByTestId("email-status");
    expect(within(status).getByText(/^Without a webhook signing secret/)).toHaveClass(
      "text-muted-foreground",
    );
    expect(within(status).getByText(/^Saved but can no longer be read/)).toHaveClass("text-destructive");
    expect(screen.getByLabelText("API token")).toHaveAttribute(
      "placeholder",
      "Saved, but can no longer be read: enter it again",
    );
    expect(screen.getByText(/Last signed event: 23.11.2026 10:00./)).toBeInTheDocument();
  });

  it("shows the confirmation texts and sends them with the switch", async () => {
    const { calls } = mockApi({
      ...meta,
      [`GET ${URL}`]: { body: emailPage() },
      [`PUT ${URL}`]: { body: { ...emailPage(), message: "The email settings were saved." } },
    });
    const user = userEvent.setup();
    await openPage();
    expect(screen.getByLabelText("Text (Deutsch)")).toHaveValue("Hallo {name},\n");
    expect(screen.getByLabelText("Subject (English)")).toHaveValue(
      "Confirmation of receipt: reimbursement claim {reference}",
    );
    expect(screen.getByText("{reference}").tagName).toBe("CODE");
    await user.click(screen.getByLabelText("Send participants a confirmation of receipt"));
    const subject = screen.getByLabelText("Subject (English)");
    await user.clear(subject);
    await user.type(subject, "Got it: {{reference}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const body = await calls.find((call) => call.method === "PUT")!.json();
    expect(body.confirmationEnabled).toBe(false);
    expect(body.confirmation.en).toEqual({ subject: "Got it: {reference}", body: "Hello {name},\n" });
  });

  it("sends a test email with the saved settings and says what happened", async () => {
    const answers = [
      {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "Enter the email address for the test email.",
            fields: { to: "Enter the email address for the test email." },
          },
        },
      },
      { body: { reached: false, message: "The SMTP server refused the recipient." } },
      { body: { reached: true, message: "The SMTP server accepted the test email to kim@example.invalid." } },
    ];
    const { calls } = mockApi({
      ...meta,
      [`GET ${URL}`]: { body: emailPage() },
      [`POST ${TEST_URL}`]: () => answers.shift()!,
    });
    const user = userEvent.setup();
    await openPage();
    const to = screen.getByLabelText("Send a test email to");
    expect(to).toHaveValue(ADMIN.email);
    await user.clear(to);
    await user.type(to, "kim@example.invalid");
    const send = screen.getByRole("button", { name: "Send test email" });
    await user.click(send);
    expect(await screen.findByText("Enter the email address for the test email.")).toBeInTheDocument();
    await user.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("The SMTP server refused the recipient.");
    await user.click(send);
    expect(
      (await screen.findAllByText("The SMTP server accepted the test email to kim@example.invalid.")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("The SMTP server refused the recipient.")).toBeNull();
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(3);
    expect(await posts[0]!.json()).toEqual({ to: "kim@example.invalid" });
  });
});
