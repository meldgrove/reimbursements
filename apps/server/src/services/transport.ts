/**
 * The transport seam for outbound email (portal/services/transport.py of the
 * Django version).
 *
 * Adapters: `LocalOutbox` (development, captures .eml files),
 * `MailerSendTransport` (services/mailersend.ts) and `SmtpTransport`
 * (services/smtp.ts); services/outbound.ts chooses one. An adapter returns a
 * `SendResult`; an exception from `send` means the outcome is unknown.
 */
import { randomBytes } from "node:crypto";
import { outboxKey, writeBytes } from "./storage";

// States of a sent email's record. `PENDING` from a transport means "retry later, nothing
// was accepted".
export const PENDING = "pending";
export const SENDING = "sending";
export const ACCEPTED = "provider_accepted";
export const PAUSED = "paused";
export const DELIVERED = "delivered";
export const FAILED = "failed";
export const UNKNOWN = "send_unknown";
/** Outcomes that neither a late send result nor later provider evidence can regress. */
export const FINAL: ReadonlySet<string> = new Set([DELIVERED, FAILED]);

export type Message = {
  attemptId: string;
  sender: string;
  replyTo: string;
  recipient: string;
  subject: string;
  text: string;
  attachment?: Uint8Array | null;
  filename?: string;
};

export type SendResult = {
  state: string;
  messageId: string;
  errorCode: string;
  /** Seconds to wait before another try of a PENDING result. */
  retryAfter: number;
};

export function sendResult(
  state: string,
  values: { messageId?: string; errorCode?: string; retryAfter?: number } = {},
): SendResult {
  return {
    state,
    messageId: values.messageId ?? "",
    errorCode: values.errorCode ?? "",
    retryAfter: values.retryAfter ?? 0,
  };
}

export interface Transport {
  send(message: Message): Promise<SendResult>;
}

/** An RFC 2047 encoded word when the header holds anything but printable ASCII. */
function headerText(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?utf-8?b?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Base64 in lines of 76 characters, as MIME wants it. */
function base64Lines(content: Uint8Array): string {
  return (
    Buffer.from(content)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

/** The complete message as an .eml file (Python's EmailMessage.as_bytes of the Django version). */
export function buildEml(message: Message): Buffer {
  const headers = [
    `From: ${headerText(message.sender)}`,
    `To: ${headerText(message.recipient)}`,
    `Subject: ${headerText(message.subject)}`,
    `Reply-To: ${headerText(message.replyTo)}`,
    "MIME-Version: 1.0",
  ];
  const text = [
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(message.text, "utf8")),
  ].join("\r\n");
  if (message.attachment === undefined || message.attachment === null) {
    return Buffer.from([...headers, text, ""].join("\r\n"), "utf8");
  }
  const boundary = `===============${randomBytes(12).toString("hex")}==`;
  const filename = (message.filename ?? "").replace(/["\r\n]/g, "_");
  const attachment = [
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${headerText(filename)}"`,
    "",
    base64Lines(message.attachment),
  ].join("\r\n");
  return Buffer.from(
    [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      text,
      `--${boundary}`,
      attachment,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

/** Local development: store the complete email privately and send nothing. */
export class LocalOutbox implements Transport {
  async send(message: Message): Promise<SendResult> {
    await writeBytes(outboxKey(message.attemptId), buildEml(message));
    return sendResult(DELIVERED, { messageId: `local-${message.attemptId}` });
  }
}

/** No provider is set up: nothing is sent, and the email waits for one. */
export class NotSetUp implements Transport {
  async send(): Promise<SendResult> {
    return sendResult(PENDING, { errorCode: "email_not_set_up", retryAfter: 900 });
  }
}
