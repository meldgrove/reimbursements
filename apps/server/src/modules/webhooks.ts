import { Hono } from "hono";
import type { AppEnv } from "../http/env";
import { noteWebhook } from "../services/email-connection";
import * as evidence from "../services/evidence";
import { InvalidEvent, verifyWebhook, webhookEvidence } from "../services/mailersend";

/**
 * MailerSend's webhook (/webhooks/mailersend/, the mailersend_webhook view of
 * the Django version). The signature proves the request, so it is mounted
 * outside the API's same-origin check. The webhook's own test ping is signed
 * with MailerSend's fixed test secret and changes nothing. Admin > Email shows
 * when the last signed event arrived.
 */
const router = new Hono<AppEnv>();

const invalid = { error: "invalid_event" };

router.post("/webhooks/mailersend/", async (c) => {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return c.json(invalid, 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return c.json(invalid, 400);
  const event = data as Record<string, unknown>;
  const test = event.type === "webhook.test";
  if (!(await verifyWebhook(raw, c.req.header("signature") ?? "", { test }))) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  if (!test) {
    // Admin > Email shows it: the webhook and its signing secret work.
    await noteWebhook();
    let provided;
    try {
      provided = webhookEvidence(event);
    } catch (error) {
      if (error instanceof InvalidEvent) return c.json(invalid, 400);
      throw error;
    }
    if (provided) await evidence.record(provided);
  }
  return c.json({ received: true });
});

export default router;
