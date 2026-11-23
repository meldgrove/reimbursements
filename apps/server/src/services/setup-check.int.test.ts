// tests/test_setup_check.py of the Django version.
import { createHmac } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import { eq, gt, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { getDb } from "../db/client";
import {
  claimReferenceCounters,
  claims,
  deliveries,
  deliveryAttempts,
  drafts,
  formTemplates,
  forms,
  operations as operationRows,
  uploads,
} from "../db/schema";
import { providerFetch } from "../auth/oidc";
import { freshState, localSettings } from "../test/back-office";
import { request } from "../test/helpers";
import { mockProvider } from "../test/mailersend";
import { runOne } from "./jobs";
import * as outbound from "./outbound";
import { EICAR, FORM_NAME, SetupCheck, seams } from "./setup-check";
import { pathFor, writeHeartbeat } from "./storage";
import { LocalOutbox, type Message } from "./transport";

beforeEach(async () => {
  await freshState();
  // As in the Django tests: no sign-in provider is set up, so its step is skipped.
  localSettings({ oidcEnabled: false });
});
afterEach(() => {
  outbound.transportOverride.current = null;
  vi.restoreAllMocks();
});

/** Each wait of the check runs the worker's next job and counts as one second. */
class Worker {
  now = 0;
  afterJob: () => Promise<void> = async () => undefined;

  constructor() {
    vi.spyOn(seams, "clock").mockImplementation(() => this.now);
    vi.spyOn(seams, "pause").mockImplementation(async () => {
      await runOne();
      await this.afterJob();
      this.now += 1;
    });
    writeHeartbeat();
  }
}

/** The messages the check sends, kept in the local outbox as configured. */
function recordSent(): Message[] {
  const messages: Message[] = [];
  const local = new LocalOutbox();
  outbound.transportOverride.current = {
    send: (message) => {
      messages.push(message);
      return local.send(message);
    },
  };
  return messages;
}

/** Runs verify-setup: what it printed and its refusal, if any. */
async function verify(args: string[]): Promise<[string, string | null]> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const { COMMANDS } = await import("../commands");
    await COMMANDS.get("verify-setup")!.run(args);
    return [chunks.join(""), null];
  } catch (error) {
    return [chunks.join(""), (error as Error).message];
  } finally {
    process.stdout.write = original;
  }
}

async function nothingLeft(): Promise<boolean> {
  return (
    (await getDb().select().from(claims)).length === 0 &&
    (await getDb().select().from(drafts)).length === 0 &&
    (await getDb().select().from(uploads)).length === 0 &&
    (await getDb().select().from(forms).where(like(forms.slug, "setup-check-%"))).length === 0 &&
    (await getDb().select().from(formTemplates).where(like(formTemplates.name, "Setup check%"))).length === 0
  );
}

describe("the setup check", () => {
  it("passes every step with a synthetic claim and deletes it", async () => {
    new Worker();
    const sent = recordSent();
    const [output, error] = await verify([
      "--to",
      "finance@example.invalid",
      "--confirmation-to",
      "kim@example.invalid",
    ]);
    expect(error, output).toBeNull();
    for (const step of [
      "ok    Receipt and signature checked and normalized",
      "submitted, without a bookkeeping number",
      "ok    PDF created (",
      "ok    Finance email to finance@example.invalid kept in the local outbox",
      "ok    Participant confirmation to kim@example.invalid kept in the local outbox",
      "ok    Test claim, form and template deleted",
    ]) {
      expect(output).toContain(step);
    }
    const finance = sent.find((message) => message.attachment)!;
    const confirmation = sent.find((message) => !message.attachment)!;
    expect(finance.recipient).toBe("finance@example.invalid");
    expect(finance.subject).toContain(FORM_NAME);
    expect(finance.subject).not.toContain("Erst/");
    expect(Buffer.from(finance.attachment!).subarray(0, 4).toString()).toBe("%PDF");
    expect([confirmation.recipient, confirmation.attachment ?? null]).toEqual(["kim@example.invalid", null]);
    expect(await nothingLeft()).toBe(true);
    // Finance's numbering continues without a gap.
    expect(
      await getDb().select().from(claimReferenceCounters).where(gt(claimReferenceCounters.value, 0)),
    ).toHaveLength(0);
    const [operation] = await getDb().select().from(operationRows);
    expect(operation!.actor).toBe("verify_setup");
    const outbox = pathFor("outbox");
    expect(existsSync(outbox) ? readdirSync(outbox) : []).toEqual([]);
  }, 120_000);

  it.each([
    [["--to", "someone@example.invalid"], [], "APPROVED_DELIVERY_RECIPIENTS"],
    [
      ["--to", "finance@example.invalid", "--confirmation-to", "kim@example.invalid"],
      ["finance@example.invalid"],
      "TEST_RECIPIENT_ALLOWLIST does not include kim@example.invalid",
    ],
    [["--to", "not an address"], [], "is not an email address"],
  ])("checks the recipients before it creates anything (%o)", async (args, allowlist, message) => {
    new Worker();
    localSettings({ TEST_RECIPIENT_ALLOWLIST: allowlist });
    const [output, error] = await verify(args);
    expect(error).toContain(message);
    expect(output).toBe("");
    expect(await nothingLeft()).toBe(true);
  });

  it("submits no claim without a running worker", async () => {
    vi.spyOn(seams, "sandboxReady").mockResolvedValue(true);
    const [output, error] = await verify(["--to", "finance@example.invalid"]);
    expect(error).toBe("Setup check failed: 1 problem.");
    expect(output).toContain("FAIL  Worker\n        No recent heartbeat.");
    expect(output).toContain("skip  Test claim");
    expect(await nothingLeft()).toBe(true);
  });

  it("names a claim a job still holds for deletion", async () => {
    const worker = new Worker();
    vi.spyOn(seams, "deleteClaim").mockImplementation(async () => {
      const { ActionRefused } = await import("./operations");
      throw new ActionRefused("busy", "The claim is being processed.");
    });
    const [output, error] = await verify(["--to", "finance@example.invalid"]);
    const [claim] = await getDb().select().from(claims);
    const [form] = await getDb().select().from(forms).where(eq(forms.id, claim!.formId));
    expect(error).toBe("Setup check failed: 1 problem.");
    expect(output).toContain(`FAIL  Clean-up\n        A job still holds claim ${claim!.id}.`);
    expect(output).toContain(`then delete form ${form!.slug} and template 'Setup check `);
    // A running job ends within its lease, so the clean-up waits that long.
    expect(worker.now).toBeGreaterThanOrEqual(config().JOB_LEASE_SECONDS + 60);
  }, 120_000);
});

/** A signed MailerSend webhook for an attempt, through the app. */
async function signedWebhook(
  attempt: { id: string; messageId: string | null; deliveryId: number },
  kind: string,
) {
  const [delivery] = await getDb().select().from(deliveries).where(eq(deliveries.id, attempt.deliveryId));
  const body = JSON.stringify({
    type: `activity.${kind}`,
    created_at: new Date().toISOString(),
    data: {
      id: `event-${attempt.id}-${kind}`,
      message_id: attempt.messageId,
      recipient: delivery!.recipient,
      tags: [],
    },
  });
  const signature = createHmac("sha256", config().MAILERSEND_WEBHOOK_SIGNING_SECRET)
    .update(body)
    .digest("hex");
  const response = await request("POST", "/webhooks/mailersend/", {
    body,
    headers: { "content-type": "application/json", signature },
  });
  expect(response.status).toBe(200);
}

function useMailerSend() {
  localSettings({
    MAIL_DELIVERY_MODE: "mailersend",
    MAILERSEND_WEBHOOK_SIGNING_SECRET: "synthetic-test-secret",
    APP_URL: "https://reimbursements.example.invalid",
  });
  let number = 0;
  mockProvider(() => {
    number += 1;
    return new Response(null, { status: 202, headers: { "x-message-id": `message-${number}` } });
  });
}

async function acceptedAttempts() {
  return getDb().select().from(deliveryAttempts).where(eq(deliveryAttempts.state, "provider_accepted"));
}

describe("the setup check with MailerSend", () => {
  it("needs the signed webhook to arrive", async () => {
    const worker = new Worker();
    useMailerSend();
    worker.afterJob = async () => {
      for (const attempt of await acceptedAttempts()) await signedWebhook(attempt, "delivered");
    };
    const [output, error] = await verify(["--to", "finance@example.invalid"]);
    expect(error, output).toBeNull();
    for (const step of [
      "ok    MailerSend accepted the Finance email to finance@example.invalid",
      "ok    MailerSend webhook received, signature verified",
      "ok    Finance inbox received the email",
      "ok    Participant confirmation to finance@example.invalid accepted by MailerSend",
    ]) {
      expect(output).toContain(step);
    }
    expect(await nothingLeft()).toBe(true);
  }, 120_000);

  it("names the URL to configure when the webhook is missing", async () => {
    new Worker();
    useMailerSend();
    const [output, error] = await verify(["--to", "finance@example.invalid", "--timeout", "30"]);
    expect(error).toBe("Setup check failed: 1 problem.");
    expect(output).toContain("FAIL  MailerSend webhook\n        No signed delivery event within 30 s.");
    expect(output).toContain("https://reimbursements.example.invalid/webhooks/mailersend/");
    expect(output).toContain("ok    Test claim, form and template deleted");
    expect(await nothingLeft()).toBe(true);
  }, 120_000);

  it("fails on a bounce the webhook reports", async () => {
    const worker = new Worker();
    useMailerSend();
    const sent = new Set<string>();
    worker.afterJob = async () => {
      for (const attempt of await acceptedAttempts()) {
        await signedWebhook(attempt, sent.has(attempt.id) ? "hard_bounced" : "sent");
        sent.add(attempt.id);
      }
    };
    const [output, error] = await verify(["--to", "finance@example.invalid"]);
    expect(error).toBe("Setup check failed: 1 problem.");
    expect(output).toContain("FAIL  Finance inbox\n        MailerSend reports provider_hard_bounced.");
    expect(await nothingLeft()).toBe(true);
  }, 120_000);
});

type Reported = [string, string, string];

async function results(method: "scanner" | "keycloak"): Promise<Reported[]> {
  const reports: Reported[] = [];
  const check = new SetupCheck({
    finance: "finance@example.invalid",
    participant: "finance@example.invalid",
    timeout: 10,
    report: (status, title, detail) => reports.push([status, title, detail]),
  });
  await check[method]();
  return reports;
}

/** clamd on a local port: it answers every scan with `reply` and keeps what it received. */
async function fakeClamAV(reply: Buffer) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).subarray(-4).equals(Buffer.alloc(4))) socket.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => Buffer.concat(received),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("single steps", () => {
  it.each([
    ["stream: Win.Test.EICAR_HDB-1 FOUND\0", "ok"],
    ["stream: OK\0", "FAIL"],
  ])("the scanner must detect the EICAR test file (%j)", async (reply, status) => {
    const clamd = await fakeClamAV(Buffer.from(reply));
    localSettings({ UPLOAD_SCANNER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: clamd.port });
    vi.spyOn(seams, "scannerReady").mockResolvedValue(true);
    const [[reported]] = (await results("scanner")) as [Reported];
    await clamd.close();
    expect(reported).toBe(status);
    expect(clamd.received().includes(EICAR)).toBe(true);
    expect(readdirSync(pathFor("checks"))).toEqual([]);
  });

  function realm() {
    localSettings({ oidcEnabled: true });
    const issuer = config().oidcIssuer;
    const endpoint = (name: string) => `${issuer}/protocol/openid-connect/${name}`;
    const answers = {
      discovery: {
        issuer,
        authorization_endpoint: endpoint("auth"),
        token_endpoint: endpoint("token"),
        userinfo_endpoint: endpoint("userinfo"),
        jwks_uri: endpoint("certs"),
        end_session_endpoint: endpoint("logout"),
      } as Record<string, string>,
      keys: [{ kty: "RSA", use: "sig", alg: "RS256" }] as Array<Record<string, string>>,
    };
    vi.spyOn(providerFetch, "fetch").mockImplementation(async (url) => {
      if (String(url) === `${issuer}/.well-known/openid-configuration`)
        return Response.json(answers.discovery);
      if (String(url) === endpoint("certs")) return Response.json({ keys: answers.keys });
      return new Response(null, { status: 404 });
    });
    return answers;
  }

  it("the Keycloak realm must match the configured URLs", async () => {
    const answers = realm();
    const [[status, title]] = (await results("keycloak")) as [Reported];
    expect([status, title]).toEqual(["ok", `Keycloak realm ${config().oidcIssuer}`]);
    answers.discovery = { ...answers.discovery, issuer: "http://auth.example.invalid/realms/reimbursements" };
    const [[refused, , detail]] = (await results("keycloak")) as [Reported];
    expect(refused).toBe("FAIL");
    expect(detail).toContain("different issuer");
    expect(detail).toContain("'http://auth.example.invalid/realms/reimbursements'");
  });

  it("the Keycloak realm needs a signing key and an answer", async () => {
    const answers = realm();
    answers.keys = [{ kty: "oct", use: "sig" }];
    let [[status, , detail]] = (await results("keycloak")) as [Reported];
    expect(status).toBe("FAIL");
    expect(detail).toContain("no RSA key");
    localSettings({ oidcIssuer: "https://auth.example.invalid/realms/missing" });
    [[status, , detail]] = (await results("keycloak")) as [Reported];
    expect(status).toBe("FAIL");
    expect(detail).toContain("gave no OpenID configuration");
  });

  it("skips Keycloak without sign-in settings", async () => {
    localSettings({ oidcEnabled: false });
    expect((await results("keycloak"))[0]![0]).toBe("skip");
  });
});
