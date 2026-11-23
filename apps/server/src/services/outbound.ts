/**
 * Outbound email: who may receive it, how one message is sent, and what is
 * left of it (portal/services/outbound.py of the Django version).
 *
 * Finance deliveries and participant confirmations both send through `send`.
 * While a test allowlist is configured, nobody else receives email. In local
 * development `LocalOutbox` keeps a private copy of each message instead of
 * sending it. `forget` removes the copies and the provider's evidence of sent
 * messages.
 */
import { inArray, or } from "drizzle-orm";
import { config } from "../config";
import { deliveryEvents } from "../db/schema";
import { q } from "../db/tx";
import { logger } from "../logger";
import { MailerSendTransport } from "./mailersend";
import { outboxKey, removeKeys } from "./storage";
import { FAILED, LocalOutbox, sendResult, type Message, type SendResult, type Transport } from "./transport";

/** The message cannot be composed, so nothing was transmitted. `code` is the error code. */
export class Undeliverable extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "Undeliverable";
  }
}

/** A Finance inbox that forms may send claims to. */
export function recipientApproved(address: string): boolean {
  return config().APPROVED_DELIVERY_RECIPIENTS.includes(address.toLowerCase());
}

/** Tests may set a transport of their own; null: the configured one. */
export const transportOverride: { current: Transport | null } = { current: null };

export function configuredTransport(): Transport {
  if (transportOverride.current) return transportOverride.current;
  const settings = config();
  if (settings.MAIL_DELIVERY_MODE === "local" && settings.isDevelopment) return new LocalOutbox();
  return new MailerSendTransport();
}

/**
 * Composes the message for `email`, a sender's record, and transmits it.
 *
 * No database writes; call outside a transaction. Anything that fails while
 * composing, or a recipient the test allowlist excludes, is a definite
 * failure: nothing reached the provider. An exception from the transport
 * propagates, because the provider may have accepted the message.
 */
export async function send<T extends { id: string }>(
  compose: (email: T) => Promise<Message>,
  email: T,
): Promise<SendResult> {
  let message: Message;
  try {
    message = await compose(email);
  } catch (error) {
    if (error instanceof Undeliverable) return sendResult(FAILED, { errorCode: error.code });
    logger.error({ err: error, email: email.id }, "email_compose_failed");
    return sendResult(FAILED, { errorCode: "message_unavailable" });
  }
  const allowlist = config().TEST_RECIPIENT_ALLOWLIST;
  if (allowlist.length && !allowlist.includes(message.recipient.toLowerCase())) {
    return sendResult(FAILED, { errorCode: "test_recipient_blocked" });
  }
  return configuredTransport().send(message);
}

/** Deletes any local copies of these messages, by their `Message.attemptId`. */
export function removeCopies(...messageIds: string[]) {
  removeKeys(...messageIds.map((id) => outboxKey(id)));
}

/**
 * Deletes the local copies and the recorded provider evidence of these sent
 * emails (senders' records). Evidence goes whether or not it was applied: it
 * names an email by the record it was tagged with or by its provider message ID.
 */
export async function forget(...emails: Array<{ id: string; messageId: string | null }>) {
  if (!emails.length) return;
  removeCopies(...emails.map((email) => email.id));
  const messageIds = emails.map((email) => email.messageId).filter((id): id is string => Boolean(id));
  const tagged = inArray(
    deliveryEvents.attemptTag,
    emails.map((email) => email.id),
  );
  await q()
    .delete(deliveryEvents)
    .where(messageIds.length ? or(tagged, inArray(deliveryEvents.messageId, messageIds)) : tagged);
}
