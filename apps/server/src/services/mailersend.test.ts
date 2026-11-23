// Which fetch failures happened before a request left (definite, retried)
// and which leave the outcome unknown (portal/services/mailersend.py: httpx's
// ConnectError, which includes TLS handshake failures).
import net from "node:net";
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

  it("a TLS handshake with a server that does not speak TLS happened before transmission", async () => {
    // Answers in plain HTTP: the client's TLS fails on the first record, before any request.
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const failure = await fetch(`https://127.0.0.1:${port}/`).then(
        () => null,
        (error: unknown) => error,
      );
      expect(connectionRefused(failure)).toBe(true);
    } finally {
      server.close();
    }
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"])("%s may have reached MailerSend", (code) =>
    expect(connectionRefused(fetchFailure(code))).toBe(false),
  );
});
