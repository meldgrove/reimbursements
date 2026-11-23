// Which fetch failures happened before a request left (definite, retried)
// and which leave the outcome unknown (portal/services/mailersend.py: httpx's
// ConnectError, which includes TLS handshake failures).
import { describe, expect, it } from "vitest";
import { connectionRefused } from "./mailersend";

/** A fetch failure as undici reports it: a TypeError with the socket's error as cause. */
const fetchFailure = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

describe("connection failures", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("%s happened before transmission", (code) => expect(connectionRefused(fetchFailure(code))).toBe(true));

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"])("%s may have reached MailerSend", (code) =>
    expect(connectionRefused(fetchFailure(code))).toBe(false),
  );
});
