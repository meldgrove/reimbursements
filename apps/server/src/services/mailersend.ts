/**
 * MailerSend: the deployment transport adapter and its delivery evidence
 * (portal/services/mailersend.py of the Django version).
 *
 * Webhooks and message lookups become `Evidence` here; MailerSend's payloads,
 * event and status names and the attempt tag format stay in this module.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { APP_NAME } from "../constants";
import {
  ACCEPTED,
  DELIVERED,
  FAILED,
  PAUSED,
  PENDING,
  UNKNOWN,
  sendResult,
  type Message,
  type SendResult,
  type Transport,
} from "./transport";

/** What each webhook event ("activity.*") or looked-up status ("reconciliation.*") shows. */
export const EVIDENCE_STATES: Readonly<Record<string, string>> = {
  "activity.sent": ACCEPTED,
  "activity.delivered": DELIVERED,
  "activity.deferred": ACCEPTED,
  "activity.soft_bounced": ACCEPTED,
  "activity.hard_bounced": FAILED,
  "activity.suppressed": FAILED,
  "reconciliation.queued": ACCEPTED,
  "reconciliation.sent": ACCEPTED,
  "reconciliation.delivered": DELIVERED,
  "reconciliation.soft_bounced": ACCEPTED,
  "reconciliation.hard_bounced": FAILED,
  "reconciliation.suppressed": FAILED,
  "reconciliation.rejected": FAILED,
};
/** Evidence that the provider has the message, without saying more than that. */
const RESOLVES_UNKNOWN_ONLY = new Set(["reconciliation.queued"]);
export const ATTEMPT_TAG = "attempt-";
export const API_URL = "https://api.mailersend.com/v1/";
const MESSAGE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The whole call; connecting alone fails after 10 s (Node's fetch). */
const TIMEOUT_MS = 30_000;

/**
 * The HTTP seam: tests replace `fetch` to play MailerSend (the Django tests
 * replaced its httpx client).
 */
export const provider = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return provider.fetch(new URL(path, API_URL).toString(), {
    ...init,
    headers: {
      Authorization: `Bearer ${config().MAILERSEND_API_TOKEN}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Error codes of failures that happen before a request leaves: nothing reached MailerSend. */
const BEFORE_TRANSMISSION = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET_CONNECT",
  "ConnectError",
  // The TLS handshake refused the server's certificate: no request was sent (httpx's ConnectError).
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Whether `error` from fetch is a connection failure known to precede acceptance. */
export function connectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && BEFORE_TRANSMISSION.has(code)) return true;
    if ((current as { name?: unknown }).name === "ConnectError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Deployment transport: the MailerSend email API. */
export class MailerSendTransport implements Transport {
  async send(message: Message): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      from: { email: message.sender, name: APP_NAME },
      to: [{ email: message.recipient }],
      reply_to: { email: message.replyTo },
      subject: message.subject,
      text: message.text,
      tags: ["reimbursements", `${ATTEMPT_TAG}${message.attemptId}`],
      settings: { track_opens: false, track_clicks: false, track_content: false },
    };
    if (message.attachment !== undefined && message.attachment !== null) {
      payload.attachments = [
        {
          content: Buffer.from(message.attachment).toString("base64"),
          filename: message.filename ?? "",
          disposition: "attachment",
        },
      ];
    }
    let response: Response;
    let body: string;
    try {
      response = await call("email", { method: "POST", body: JSON.stringify(payload) });
      body = await response.text();
    } catch (error) {
      // Connection failures known to precede acceptance can retry.
      if (connectionRefused(error)) {
        return sendResult(PENDING, { errorCode: "provider_connection", retryAfter: 60 });
      }
      return sendResult(UNKNOWN, { errorCode: "provider_outcome_unknown" });
    }
    if (response.status === 429) {
      const header = response.headers.get("retry-after") ?? "60";
      const seconds = /^\s*[+-]?\d+\s*$/.test(header) ? Number.parseInt(header, 10) : 60;
      return sendResult(PENDING, {
        errorCode: "provider_throttled",
        retryAfter: Math.min(3600, Math.max(60, seconds)),
      });
    }
    if (response.status >= 500) return sendResult(UNKNOWN, { errorCode: "provider_outcome_unknown" });
    if (response.status !== 202) return sendResult(FAILED, { errorCode: "provider_rejected" });
    let warnings: unknown = [];
    if (body) {
      try {
        const parsed: unknown = JSON.parse(body);
        warnings =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? ((parsed as { warnings?: unknown }).warnings ?? [])
            : (() => {
                throw new Error("not an object");
              })();
      } catch {
        return sendResult(UNKNOWN, { errorCode: "provider_response_invalid" });
      }
    }
    if (
      Array.isArray(warnings) &&
      warnings.some(
        (warning) =>
          warning &&
          typeof warning === "object" &&
          ["ALL_SUPPRESSED", "SOME_SUPPRESSED"].includes((warning as { type?: unknown }).type as string),
      )
    ) {
      return sendResult(FAILED, { errorCode: "recipient_suppressed" });
    }
    const messageId = response.headers.get("x-message-id") ?? "";
    if (!MESSAGE_ID.test(messageId)) {
      return sendResult(UNKNOWN, { errorCode: "provider_message_id_missing" });
    }
    const paused = (response.headers.get("x-send-paused") ?? "").toLowerCase() === "true";
    return sendResult(paused ? PAUSED : ACCEPTED, { messageId });
  }
}

/** MailerSend's fixed secret for the test ping of a webhook's setup page. */
export const WEBHOOK_TEST_SECRET = "test_Am3L1GuOIc4blLUuHqAPxxwkZaJyEk8G";

export function verifyWebhook(
  raw: Uint8Array | string,
  signature: string | undefined | null,
  options: { test?: boolean } = {},
): boolean {
  const secret = options.test ? WEBHOOK_TEST_SECRET : config().MAILERSEND_WEBHOOK_SIGNING_SECRET;
  if (!secret || typeof signature !== "string") return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The message as MailerSend reports it, or null when it could not be asked. */
export async function retrieveMessage(messageId: string): Promise<unknown> {
  if (!MESSAGE_ID.test(messageId)) return null;
  try {
    const response = await call(`messages/${messageId}`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    return (body as { data?: unknown }).data ?? null;
  } catch {
    return null;
  }
}

type Snapshot = { status: string; recipient: unknown; id: unknown };

const SNAPSHOT_STATUSES = new Set([
  "delivered",
  "hard_bounced",
  "soft_bounced",
  "suppressed",
  "sent",
  "queued",
  "rejected",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Only interpret explicitly documented email statuses, never an empty emails list. */
export function messageSnapshot(message: unknown): Snapshot | null {
  if (!isRecord(message)) return null;
  const emails = message.emails;
  if (!Array.isArray(emails)) return null;
  for (const email of emails) {
    if (!isRecord(email)) continue;
    let status = email.status;
    if (status === "rejected") {
      // Rejection is terminal even when no webhook/activity was recorded.
      // Prefer documented suppression or bounce details when available.
      const reason = email.suppression_reason;
      const activities = email.activity || [];
      const kinds = new Set(
        Array.isArray(activities) ? activities.filter(isRecord).map((item) => item.type) : [],
      );
      if (reason === "hard_bounced" || kinds.has("hard_bounced")) {
        status = "hard_bounced";
      } else if (
        ["on_hold", "unsubscribed", "spam_complained", "blocklisted"].includes(reason as string) ||
        kinds.has("suppressed")
      ) {
        status = "suppressed";
      }
    }
    if (typeof status === "string" && SNAPSHOT_STATUSES.has(status)) {
      const recipient = email.recipient;
      return {
        status,
        recipient: email.to || (isRecord(recipient) ? recipient.email : recipient),
        id: email.id ?? "",
      };
    }
  }
  return null;
}

/** What MailerSend says about one message. `kind` names the event or status. */
export type Evidence = {
  kind: string;
  /** Unique per piece of evidence, so a repeated webhook is recorded once. */
  providerId: string;
  timestamp: Date;
  messageId: string;
  recipient: string;
  /** The attempt that sent the message, from its tag; empty when unknown. */
  attemptId: string;
};

/**
 * The record state that evidence of `kind` shows, its error code, and whether
 * it may only resolve an unknown outcome.
 */
export function outcome(kind: string): [state: string, errorCode: string, resolvesUnknownOnly: boolean] {
  const state = EVIDENCE_STATES[kind];
  if (!state) throw new Error(`Unknown evidence kind ${kind}`);
  const errorCode = state === FAILED ? `provider_${kind.slice(kind.lastIndexOf(".") + 1)}` : "";
  return [state, errorCode, RESOLVES_UNKNOWN_ONLY.has(kind)];
}

/** A webhook payload that is no valid event. */
export class InvalidEvent extends Error {
  constructor() {
    super("invalid_event");
    this.name = "InvalidEvent";
  }
}

/** ISO 8601 date and time, with or without a UTC offset (the formats Django's parse_datetime reads). */
const DATETIME =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,6})\d*)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Django's parse_datetime of a payload value: null when it is no date and
 * time, `naive` without an offset. Throws InvalidEvent for a value that is
 * no text, or well formed but no valid date (Django raised there too).
 */
function parseDatetime(value: unknown): { date: Date; naive: boolean } | null {
  if (typeof value !== "string") throw new InvalidEvent();
  const match = DATETIME.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  const parts = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)];
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number];
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  ) {
    throw new InvalidEvent();
  }
  const offset = !zone
    ? 0
    : zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.replace(":", "").slice(3, 5) || "0"));
  const utc = check.getTime() + Number(fraction.padEnd(3, "0").slice(0, 3));
  return { date: new Date(utc - offset * 60_000), naive: !zone };
}

/**
 * Evidence from a verified webhook payload, or null for an event that is not
 * evidence. Throws InvalidEvent for a malformed payload.
 */
export function webhookEvidence(data: Record<string, unknown>): Evidence | null {
  if (data.data !== undefined && !isRecord(data.data)) throw new InvalidEvent();
  const body = isRecord(data.data) ? data.data : ({} as Record<string, unknown>);
  const parsed = parseDatetime(data.created_at ?? "");
  const type = data.type;
  if (typeof type !== "string" || !(type in EVIDENCE_STATES) || type.startsWith("reconciliation.")) {
    return null;
  }
  const timestamp = parsed && !parsed.naive ? parsed.date : null;
  const providerId = body.id;
  const recipient = body.recipient;
  if (
    typeof providerId !== "string" ||
    providerId.length < 1 ||
    providerId.length > 100 ||
    typeof recipient !== "string" ||
    recipient.length > 254 ||
    !timestamp
  ) {
    throw new InvalidEvent();
  }
  const tags = body.tags ?? [];
  let attemptId = "";
  if (Array.isArray(tags)) {
    const tag = tags.find(
      (value): value is string =>
        typeof value === "string" && value.startsWith(ATTEMPT_TAG) && value.length === 44,
    );
    attemptId = tag ? tag.slice(ATTEMPT_TAG.length) : "";
  }
  const messageId = body.message_id ?? "";
  if (typeof messageId !== "string" || messageId.length > 100) throw new InvalidEvent();
  return { kind: type, providerId, timestamp, messageId, recipient, attemptId };
}

/** MailerSend could not be asked about a message. */
export class LookupFailed extends Error {
  constructor() {
    super("lookup_failed");
    this.name = "LookupFailed";
  }
}

/**
 * Evidence from asking MailerSend about a sent message; null while it has no
 * answer. Throws LookupFailed when the lookup itself fails.
 */
export async function lookup(attemptId: string, messageId: string): Promise<Evidence | null> {
  const message = await retrieveMessage(messageId);
  if (message === null || message === undefined) throw new LookupFailed();
  const snapshot = messageSnapshot(message);
  if (!snapshot || !snapshot.recipient) return null;
  const status = snapshot.status;
  return {
    kind: `reconciliation.${status}`,
    providerId: `reconcile-${attemptId}-${status}`,
    timestamp: new Date(),
    messageId,
    recipient: String(snapshot.recipient),
    attemptId: "",
  };
}
