/**
 * The setup check: one synthetic claim through this installation's own
 * services (portal/services/setup_check.py of the Django version).
 *
 * `cli verify-setup` runs it after a deployment, an upgrade or a credential
 * change. It checks the database, private storage, the worker, the document
 * sandbox, the malware scanner and the sign-in provider. Then it submits a
 * claim the way a participant does: receipt and signature uploads, scanning
 * and normalization, the PDF, the Finance email, the participant confirmation
 * and, with MailerSend, the signed delivery webhook.
 *
 * The claim goes through a temporary form and template. It takes no
 * bookkeeping reference, so Finance's numbering has no gap, and it is deleted
 * with them when the check ends.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, notInArray, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { config } from "../config";
import { DECLARATION, DECLARATION_VERSION } from "../constants";
import { t } from "../i18n";
import { getDb } from "../db/client";
import {
  claims,
  confirmations,
  deliveries,
  deliveryAttempts,
  deliveryEvents,
  drafts,
  formTemplates,
  forms,
  uploads,
  type Claim,
  type Form,
  type FormTemplate,
} from "../db/schema";
import { q } from "../db/tx";
import { providerFetch } from "../auth/oidc";
import * as intake from "../intake";
import { IntakeError } from "../intake";
import { currentPrivacyNotice, withTemplate } from "../models";
import type { Participant } from "../participants";
import { applied, loadSettings } from "./app-settings";
import { storageAvailable } from "./capacity";
import { CLAIM_STATES } from "./claim-status";
import { sandboxReady } from "./documents";
import { openDraft } from "./drafts";
import * as operations from "./operations";
import { queueAgeSeconds } from "./readiness";
import * as retention from "./retention";
import { ScanError, scanFile, scannerReady } from "./scanner";
import { checkWritable, heartbeatAge, pathFor } from "./storage";
import { submitClaim } from "./submissions";
import { ACCEPTED, DELIVERED, FAILED, PAUSED, PENDING, SENDING, UNKNOWN } from "./transport";
import * as uploadService from "./uploads";

export const OK = "ok";
export const FAIL = "FAIL";
export const SKIP = "skip";
export type Status = typeof OK | typeof FAIL | typeof SKIP;

const ACTOR = "verify_setup";
export const FORM_NAME = "Setup check (not a real claim)";
/** The EICAR antivirus test file, in two parts so that this source is not detected itself. */
export const EICAR = Buffer.concat([
  Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "latin1"),
  Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "latin1"),
]);
const SEND_PROBLEMS: Record<string, string> = {
  provider_rejected:
    "MailerSend refused the email. Check MAILERSEND_API_TOKEN and that MAIL_FROM_ADDRESS is on a verified MailerSend domain.",
  recipient_suppressed: "MailerSend suppresses this recipient after an earlier bounce.",
  test_recipient_blocked: "TEST_RECIPIENT_ALLOWLIST does not include the recipient.",
  unapproved_recipient: "APPROVED_DELIVERY_RECIPIENTS does not include the recipient.",
};

/**
 * What the check waits with and asks. Tests replace `pause` and `clock` to
 * run the worker's jobs in-process, and the others to play an installation.
 */
export const seams = {
  /** Waits between polls. */
  pause: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  /** Seconds on a monotonic clock. */
  clock: () => performance.now() / 1000,
  sandboxReady: () => sandboxReady(),
  scannerReady: () => scannerReady(),
  deleteClaim: (claimId: string, options: { actor: string; reason: string }) =>
    operations.deleteClaim(claimId, options),
};

/**
 * How long the clean-up waits for a job that holds the claim or an upload: a
 * job ends within its lease, and a running worker reclaims an expired one
 * within a minute.
 */
export function cleanupSeconds(): number {
  return config().JOB_LEASE_SECONDS + 60;
}

/** The check's participant (participants.ts), with its own admission budget. */
class CheckParticipant implements Participant {
  readonly network = "setup-check";
  private session: string | null = null;
  private readonly memory = new Map<string, { id: string; token: string }>();

  async binding(options: { create?: boolean } = {}) {
    if (this.session === null && options.create) this.session = randomBytes(32).toString("hex");
    return this.session;
  }

  async remembered(formSlug: string) {
    return this.memory.get(formSlug) ?? null;
  }

  async remember(formSlug: string, draftId: string, token: string) {
    this.memory.set(formSlug, { id: draftId, token });
  }
}

/** A synthetic receipt (dark bars where a receipt has text) or a signature stroke, as PNG. */
export function image(options: { signature?: boolean } = {}): Promise<Buffer> {
  const [width, height] = options.signature ? [800, 240] : [1000, 1400];
  const drawing = options.signature
    ? `<polyline points="80,160 150,60 210,170 300,80 440,150 600,100" stroke="#134e4a" stroke-width="5" fill="none"/>`
    : `<rect x="60" y="60" width="420" height="14" fill="black"/><rect x="60" y="110" width="180" height="14" fill="black"/>`;
  return sharp({ create: { width, height, channels: 3, background: "white" } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}">${drawing}</svg>`) }])
    .png()
    .toBuffer();
}

type Report = (status: Status, title: string, detail: string) => void;

/** `report(status, title, detail)` receives each result; `run()` is true without failures. */
export class SetupCheck {
  failures = 0;
  private deadline = 0;
  private claimId: string | null = null;
  private readonly finance: string;
  private readonly participant: string;
  private readonly timeout: number;
  private readonly reportTo: Report;
  /** Email stays in the local outbox (development), so no webhook is expected. */
  private readonly local: boolean;

  constructor(options: { finance: string; participant: string; timeout: number; report: Report }) {
    this.finance = options.finance;
    this.participant = options.participant;
    this.timeout = options.timeout;
    this.reportTo = options.report;
    const settings = config();
    this.local = settings.MAIL_DELIVERY_MODE === "local" && settings.isDevelopment;
  }

  report(status: Status, title: string, detail = ""): boolean {
    if (status === FAIL) this.failures += 1;
    this.reportTo(status, title, detail);
    return status !== FAIL;
  }

  async run(): Promise<boolean> {
    if (!(await this.database())) return false;
    const ready = [await this.storage(), await this.worker(), await this.sandbox(), await this.scanner()];
    await this.keycloak();
    if (ready.every(Boolean)) await this.claim();
    else this.report(SKIP, "Test claim", "Fix the problems above first.");
    return !this.failures;
  }

  async database(): Promise<boolean> {
    try {
      await getDb().execute(sql`select 1`);
    } catch (error) {
      return this.report(FAIL, "Database", `No connection: ${(error as Error).message}`.trim());
    }
    return this.report(OK, "Database");
  }

  async storage(): Promise<boolean> {
    try {
      checkWritable();
    } catch (error) {
      return this.report(FAIL, "Private storage", `Not writable: ${(error as Error).message}`);
    }
    if (!storageAvailable()) {
      return this.report(
        FAIL,
        "Private storage",
        `Less than MIN_FREE_STORAGE_BYTES (${config().MIN_FREE_STORAGE_BYTES}) free.`,
      );
    }
    return this.report(OK, "Private storage");
  }

  async worker(): Promise<boolean> {
    const age = heartbeatAge();
    if (age === null || !(age >= 0 && age < config().JOB_LEASE_SECONDS + 60)) {
      return this.report(
        FAIL,
        "Worker",
        "No recent heartbeat. Start the worker (the `worker` service) and check its log.",
      );
    }
    const backlog = await queueAgeSeconds();
    if (backlog > config().MAX_JOB_AGE_SECONDS) {
      return this.report(FAIL, "Worker", `The oldest waiting job is ${backlog} s old: the worker is behind.`);
    }
    return this.report(OK, `Worker (heartbeat ${Math.round(age)} s ago)`);
  }

  async sandbox(): Promise<boolean> {
    if (!(await seams.sandboxReady())) {
      return this.report(
        FAIL,
        "Document sandbox",
        "Needs Linux with Landlock ABI 3 or newer and libseccomp2; see docs/operations.md.",
      );
    }
    if (!config().DOCUMENT_SANDBOX_ENABLED)
      return this.report(SKIP, "Document sandbox", "Disabled in development.");
    return this.report(OK, "Document sandbox");
  }

  async scanner(): Promise<boolean> {
    const settings = config();
    if (settings.UPLOAD_SCANNER === "disabled" && settings.isDevelopment) {
      return this.report(SKIP, "Malware scanner", "Disabled in development.");
    }
    if (settings.UPLOAD_SCANNER !== "clamav")
      return this.report(FAIL, "Malware scanner", "Set UPLOAD_SCANNER=clamav.");
    if (!(await seams.scannerReady())) {
      return this.report(
        FAIL,
        "Malware scanner",
        `ClamAV at ${settings.CLAMAV_HOST}:${settings.CLAMAV_PORT} does not answer. Its first start can take several minutes.`,
      );
    }
    const probe = pathFor(`checks/${randomUUID()}`);
    mkdirSync(path.dirname(probe), { recursive: true, mode: 0o700 });
    writeFileSync(probe, EICAR);
    try {
      await scanFile(probe);
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      if (error.code === "malware_detected")
        return this.report(OK, "Malware scanner detects the EICAR test file");
      return this.report(FAIL, "Malware scanner", `The scan failed: ${error.code}.`);
    } finally {
      rmSync(probe, { force: true });
    }
    return this.report(
      FAIL,
      "Malware scanner",
      "ClamAV did not detect the EICAR test file. Check that its signatures are current.",
    );
  }

  /** The sign-in provider answers as configured (Keycloak: the realm's URLs). */
  async keycloak(): Promise<boolean> {
    const settings = config();
    if (!settings.oidcEnabled) {
      return this.report(SKIP, "Keycloak", "Not configured; development signs in with DEV_LOGIN.");
    }
    const realm = settings.oidcIssuer;
    const keycloak = settings.oidcProviderKind === "keycloak";
    const endpoint = (name: string) => `${realm}/protocol/openid-connect/${name}`;
    const expected: Record<string, string | undefined> = {
      issuer: realm,
      authorization_endpoint:
        settings.OIDC_AUTHORIZATION_ENDPOINT ?? (keycloak ? endpoint("auth") : undefined),
      token_endpoint: settings.OIDC_TOKEN_ENDPOINT ?? (keycloak ? endpoint("token") : undefined),
      userinfo_endpoint: settings.OIDC_USERINFO_ENDPOINT ?? (keycloak ? endpoint("userinfo") : undefined),
      jwks_uri: settings.OIDC_JWKS_ENDPOINT ?? (keycloak ? endpoint("certs") : undefined),
      end_session_endpoint: settings.OIDC_LOGOUT_ENDPOINT ?? (keycloak ? endpoint("logout") : undefined),
    };
    const where = keycloak ? "Check KEYCLOAK_BASE_URL and KEYCLOAK_REALM." : "Check OIDC_ISSUER.";
    let discovery: Record<string, unknown>;
    let keys: unknown;
    let differing: string[];
    try {
      const get = async (url: string) => {
        const response = await providerFetch.fetch(url, {
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as unknown;
      };
      const answer = await get(`${realm}/.well-known/openid-configuration`);
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("not an object");
      discovery = answer as Record<string, unknown>;
      differing = Object.entries(expected)
        .filter(([key, value]) => value !== undefined && discovery[key] !== value)
        .map(([key]) => key);
      const jwks = await get(String(expected.jwks_uri ?? discovery.jwks_uri));
      keys = jwks && typeof jwks === "object" ? (jwks as { keys?: unknown }).keys : undefined;
    } catch (error) {
      return this.report(
        FAIL,
        "Keycloak",
        `${realm} gave no OpenID configuration (${(error as Error).message}). ${where}`,
      );
    }
    if (differing.length) {
      return this.report(
        FAIL,
        "Keycloak",
        `The realm reports a different ${differing.join(", ")}: its issuer is '${String(discovery.issuer)}', this app expects '${realm}'. ` +
          (keycloak
            ? "Set KEYCLOAK_BASE_URL to the URL Keycloak uses for itself."
            : "Set OIDC_ISSUER to the issuer the provider names."),
      );
    }
    const kty =
      { RS: "RSA", PS: "RSA", ES: "EC", Ed: "OKP", HS: null }[settings.OIDC_SIGN_ALGO.slice(0, 2)] ?? "RSA";
    if (
      kty &&
      !(
        Array.isArray(keys) &&
        keys.some(
          (key) =>
            key &&
            typeof key === "object" &&
            (key as { kty?: unknown }).kty === kty &&
            ((key as { use?: unknown }).use ?? "sig") === "sig",
        )
      )
    ) {
      return this.report(FAIL, "Keycloak", `The realm has no ${kty} key to sign ID tokens.`);
    }
    return this.report(
      OK,
      keycloak ? `Keycloak realm ${realm}` : `Sign-in provider ${realm}`,
      "Sign in at /admin/ once to check the group mapping.",
    );
  }

  async claim(): Promise<boolean> {
    if ((await currentPrivacyNotice()) === null) {
      return this.report(FAIL, "Test claim", "Publish a privacy notice in the admin area.");
    }
    this.deadline = seams.clock() + this.timeout;
    const suffix = randomBytes(6).toString("hex");
    const general = await loadSettings();
    const [template] = await q()
      .insert(formTemplates)
      .values({
        name: `Setup check ${suffix}`,
        description: "Created by verify-setup; deleted when the check ends.",
        travel: "off",
        // The standard declaration in the app language, as a new template gets it.
        declaration: applied(general, general.language, () => t(DECLARATION)),
        declarationVersion: DECLARATION_VERSION,
      })
      .returning();
    // Closes by itself should the clean-up fail.
    const [form] = await q()
      .insert(forms)
      .values({
        templateId: template!.id,
        slug: `setup-check-${suffix}`,
        name: FORM_NAME,
        recipient: this.finance,
        supportEmail: this.finance,
        status: "published",
        closesAt: new Date(Date.now() + (this.timeout + cleanupSeconds()) * 1000),
      })
      .returning();
    try {
      if (await this.submit(form!)) await this.follow();
    } finally {
      await this.remove(form!, template!);
    }
    return true;
  }

  /** Polls `condition` until it returns a value; null after the deadline. */
  private async until<T>(condition: () => Promise<T | null | undefined | false>): Promise<T | null> {
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (seams.clock() >= this.deadline) return null;
      await seams.pause();
    }
  }

  private async submit(form: Form): Promise<boolean> {
    const participant = new CheckParticipant();
    const row = randomUUID();
    const general = await loadSettings();
    // The claim, its PDF and emails use the app language, as a participant's would.
    return applied(general, general.language, async () => {
      let files;
      try {
        const { draft, token } = await openDraft(participant, await withTemplate(form));
        files = [];
        for (const kind of ["receipt", "signature"] as const) {
          const content = await image({ signature: kind === "signature" });
          const incoming = pathFor(`incoming/setup-check-${randomUUID()}`);
          mkdirSync(path.dirname(incoming), { recursive: true, mode: 0o700 });
          writeFileSync(incoming, content);
          try {
            files.push(
              await uploadService.accept(participant, form.slug, {
                file: { name: `setup-check-${kind}.png`, size: content.length, path: incoming },
                kind,
                expenseId: row,
                draftId: draft.id,
                token,
              }),
            );
          } finally {
            rmSync(incoming, { force: true });
          }
        }
        if (!(await this.checked(files.map((upload) => upload.id)))) return false;
        let claim: Claim;
        try {
          claim = await submitClaim(
            participant,
            form.slug,
            {
              draft_id: draft.id,
              token,
              full_name: "Setup Check",
              email: this.participant,
              street: "Setup check 1",
              postal_code: "12345",
              city: "Setup check",
              country: "DE",
              account_holder: "Setup Check",
              // The standard example IBAN; no real account.
              iban: "DE89370400440532013000",
              bic: "",
              purpose: "Setup check, not a real claim: do not pay",
              purpose_details: "",
              declaration: true,
              privacy_acknowledged: true,
              signature: files[1]!.id,
              expenses: [
                {
                  id: row,
                  merchant: "Setup check",
                  receipt_reference: "SETUP-CHECK",
                  amount: "1,00",
                  uploads: [files[0]!.id],
                },
              ],
            },
            { numbered: false },
          );
        } catch (error) {
          if (!(error instanceof IntakeError)) throw error;
          return this.report(FAIL, "Test claim", `Refused: ${error.message} ${JSON.stringify(error.errors)}`);
        }
        this.claimId = claim.id;
        return this.report(OK, `Test claim ${claim.id} submitted, without a bookkeeping number`);
      } catch (error) {
        if (!(error instanceof IntakeError)) throw error;
        return this.report(FAIL, "Uploads", `Refused: ${error.message}`);
      }
    });
  }

  private async checked(uploadIds: string[]): Promise<boolean> {
    const found = await this.until(async () => {
      const rows = await q().select().from(uploads).where(inArray(uploads.id, uploadIds));
      return rows.length === uploadIds.length && rows.every((upload) => upload.state !== "pending")
        ? rows
        : null;
    });
    if (found === null) {
      const codes = [
        ...new Set(
          (await q().select({ code: uploads.errorCode }).from(uploads).where(inArray(uploads.id, uploadIds)))
            .map((row) => row.code)
            .filter(Boolean),
        ),
      ].sort();
      return this.report(
        FAIL,
        "Receipt and signature checks",
        `Not finished within ${this.timeout} s` +
          (codes.length ? ` (${codes.join(", ")}).` : ". Is the worker running jobs?"),
      );
    }
    const failed = found.filter((upload) => upload.state === "failed");
    if (failed.length) {
      return this.report(
        FAIL,
        "Receipt and signature checks",
        failed
          .map(
            (upload) =>
              `${upload.kind}: ${upload.errorCode} (${intake.message(upload.errorCode, intake.message("upload_unchecked"))})`,
          )
          .join("; "),
      );
    }
    return this.report(OK, "Receipt and signature checked and normalized");
  }

  private async follow(): Promise<boolean> {
    const claim = await this.until(async () => {
      const [row] = await q()
        .select()
        .from(claims)
        .where(
          and(eq(claims.id, this.claimId!), inArray(claims.state, [CLAIM_STATES.READY, CLAIM_STATES.FAILED])),
        );
      return row;
    });
    if (claim === null) return this.report(FAIL, "PDF", `Not created within ${this.timeout} s.`);
    if (claim.state === CLAIM_STATES.FAILED) {
      return this.report(FAIL, "PDF", `Creating the PDF failed: ${claim.errorCode}.`);
    }
    const pages = claim.pdfPageCount;
    this.report(OK, `PDF created (${pages} page${pages !== 1 ? "s" : ""})`);
    await this.financeEmail(claim);
    await this.confirmation(claim);
    return true;
  }

  private sendProblem(title: string, record: { state: string; errorCode: string } | null): boolean {
    if (record === null) return this.report(FAIL, title, `Not sent within ${this.timeout} s.`);
    let detail: string;
    if (record.state === PAUSED) detail = "MailerSend paused sending for this account; see its dashboard.";
    else if (record.state === UNKNOWN) detail = `MailerSend gave no clear answer (${record.errorCode}).`;
    else detail = SEND_PROBLEMS[record.errorCode] ?? `Sending failed: ${record.errorCode}.`;
    return this.report(FAIL, title, detail);
  }

  private async financeEmail(claim: Claim): Promise<boolean> {
    let delivery = await this.until(async () => {
      const [row] = await q()
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.claimId, claim.id), notInArray(deliveries.state, [PENDING, SENDING])));
      return row;
    });
    if (delivery === null || ![ACCEPTED, DELIVERED].includes(delivery.state)) {
      return this.sendProblem("Finance email", delivery);
    }
    if (this.local) return this.report(OK, `Finance email to ${this.finance} kept in the local outbox`);
    this.report(OK, `MailerSend accepted the Finance email to ${this.finance}`);
    if (!(await this.until(() => this.webhookReceived(claim)))) {
      const origin = config().APP_URL || "https://<your host>";
      return this.report(
        FAIL,
        "MailerSend webhook",
        `No signed delivery event within ${this.timeout} s. Check that the webhook URL is ${origin}/webhooks/mailersend/ and that MAILERSEND_WEBHOOK_SIGNING_SECRET is its signing secret.`,
      );
    }
    this.report(OK, "MailerSend webhook received, signature verified");
    delivery = await this.until(async () => {
      const [row] = await q()
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.claimId, claim.id), inArray(deliveries.state, [DELIVERED, FAILED])));
      return row;
    });
    if (delivery === null) return this.report(FAIL, "Finance inbox", `No delivery within ${this.timeout} s.`);
    if (delivery.state === FAILED) {
      return this.report(FAIL, "Finance inbox", `MailerSend reports ${delivery.errorCode}.`);
    }
    return this.report(OK, "Finance inbox received the email");
  }

  private async webhookReceived(claim: Claim): Promise<boolean> {
    const attempts = await q()
      .select({ id: deliveryAttempts.id, messageId: deliveryAttempts.messageId })
      .from(deliveryAttempts)
      .innerJoin(deliveries, eq(deliveries.id, deliveryAttempts.deliveryId))
      .where(eq(deliveries.claimId, claim.id));
    if (!attempts.length) return false;
    const messageIds = attempts.map((attempt) => attempt.messageId).filter((id): id is string => Boolean(id));
    const tagged = inArray(
      deliveryEvents.attemptTag,
      attempts.map((attempt) => attempt.id),
    );
    const [event] = await q()
      .select({ id: deliveryEvents.id })
      .from(deliveryEvents)
      .where(
        and(
          messageIds.length ? or(inArray(deliveryEvents.messageId, messageIds), tagged) : tagged,
          like(deliveryEvents.kind, "activity.%"),
        ),
      )
      .limit(1);
    return Boolean(event);
  }

  private async confirmation(claim: Claim): Promise<boolean> {
    const confirmation = await this.until(async () => {
      const [row] = await q()
        .select()
        .from(confirmations)
        .where(and(eq(confirmations.claimId, claim.id), notInArray(confirmations.state, [PENDING, SENDING])));
      return row;
    });
    if (confirmation === null || ![ACCEPTED, DELIVERED].includes(confirmation.state)) {
      return this.sendProblem("Participant confirmation", confirmation);
    }
    const where = this.local ? "kept in the local outbox" : "accepted by MailerSend";
    return this.report(OK, `Participant confirmation to ${this.participant} ${where}`);
  }

  private async remove(form: Form, template: FormTemplate): Promise<boolean> {
    const deadline = seams.clock() + cleanupSeconds();
    for (;;) {
      try {
        if (await this.removed(form)) {
          await q().delete(forms).where(eq(forms.id, form.id));
          await q().delete(formTemplates).where(eq(formTemplates.id, template.id));
          return this.report(OK, "Test claim, form and template deleted");
        }
      } catch (error) {
        const expected =
          error instanceof operations.ActionRefused ||
          error instanceof retention.ClaimBusy ||
          (error instanceof Error && "syscall" in error) ||
          // A row that still references the form (Django's ProtectedError).
          (error instanceof Error &&
            /foreign key/i.test(String((error.cause as Error | undefined)?.message ?? error.message)));
        if (!expected) throw error;
      }
      if (seams.clock() >= deadline)
        return this.report(FAIL, "Clean-up", await this.leftovers(form, template));
      await seams.pause();
    }
  }

  private async leftovers(form: Form, template: FormTemplate): Promise<string> {
    const [claim] = this.claimId
      ? await q().select({ id: claims.id }).from(claims).where(eq(claims.id, this.claimId))
      : [];
    const first = claim
      ? `A job still holds claim ${this.claimId}. Once the worker runs and has finished it, delete the claim in the admin area`
      : "A job still holds an upload. The worker deletes it when its draft expires";
    return `${first}; then delete form ${form.slug} and template '${template.name}'.`;
  }

  /** Deletes the claim and drafts; true once only the form and template are left. */
  private async removed(form: Form): Promise<boolean> {
    const [claim] = this.claimId ? await q().select().from(claims).where(eq(claims.id, this.claimId)) : [];
    if (claim && claim.state === CLAIM_STATES.PURGING) await retention.purgeClaim(claim.id);
    else if (claim) await seams.deleteClaim(claim.id, { actor: ACTOR, reason: "Setup check finished" });
    for (const draft of await q().select({ id: drafts.id }).from(drafts).where(eq(drafts.formId, form.id))) {
      await uploadService.expireDraft(draft.id);
    }
    const [draftLeft] = await q()
      .select({ id: drafts.id })
      .from(drafts)
      .where(eq(drafts.formId, form.id))
      .limit(1);
    const [claimLeft] = await q()
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.formId, form.id))
      .limit(1);
    return !draftLeft && !claimLeft;
  }
}
