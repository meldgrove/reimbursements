// The SMTP cases of tests/test_email_settings.py of the Django version, against a real
// socket server.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSmtpServer, parseMessage } from "../test/smtp-server";
import type { SmtpAccount } from "./email-connection";
import { quotedPrintable, smtpReply, SmtpTransport } from "./smtp";
import { DELIVERED, FAILED, PENDING, UNKNOWN, type Message } from "./transport";

let server: FakeSmtpServer;

beforeEach(async () => {
  server = await new FakeSmtpServer().start();
});
afterEach(async () => {
  await server.stop();
});

function account(changes: Partial<SmtpAccount> = {}): SmtpAccount {
  return { host: "127.0.0.1", port: server.port, security: "none", username: "", password: "", ...changes };
}

function message(changes: Partial<Message> = {}): Message {
  return {
    attemptId: randomUUID(),
    sender: "no-reply@example.invalid",
    replyTo: "finance@example.invalid",
    recipient: "kim@example.invalid",
    subject: "Eingangsbestätigung: Erstattungsantrag Erst/1",
    text: "Hallo Kim,\n.\nein Punkt allein auf einer Zeile, und Umlaute: äöü.\n",
    ...changes,
  };
}

describe("an SMTP server", () => {
  it("receives the complete email", async () => {
    server.credentials = ["kim", "s3cret"];
    const sent = message({ attachment: Buffer.from("%PDF-1.4 synthetic"), filename: "claim.pdf" });
    const result = await new SmtpTransport(account({ username: "kim", password: "s3cret" })).send(sent);
    expect([result.state, result.messageId]).toEqual([DELIVERED, `smtp-${sent.attemptId}`]);
    expect(server.commands).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(server.envelope).toEqual({
      from: "mail from:<no-reply@example.invalid>",
      to: "rcpt to:<kim@example.invalid>",
    });
    const [raw] = server.received;
    // Seven-bit content: any server accepts it.
    expect([...raw!].every((byte) => byte < 128)).toBe(true);
    // The line holding only a dot reached the server with a second dot.
    expect(raw!.toString("latin1")).toContain("\r\n..\r\n");
    // The server takes away the dot that protects a line holding only a dot.
    const email = parseMessage(
      Buffer.from(raw!.toString("latin1").replaceAll("\r\n..\r\n", "\r\n.\r\n"), "latin1"),
    );
    expect(email.headers.get("from")).toBe("Meldgrove Reimbursement <no-reply@example.invalid>");
    expect([email.headers.get("to"), email.headers.get("reply-to")]).toEqual([
      "kim@example.invalid",
      "finance@example.invalid",
    ]);
    expect(email.headers.get("subject")).toBe(sent.subject);
    expect(email.headers.get("message-id")).toMatch(/@example\.invalid>$/);
    expect(email.headers.get("date")).toMatch(/GMT$/);
    const [body, attachment] = email.parts;
    expect(body!.content.toString("utf8").replaceAll("\r\n", "\n")).toBe(sent.text);
    expect(attachment!.headers.get("content-disposition")).toBe('attachment; filename="claim.pdf"');
    expect(attachment!.content.toString("latin1")).toBe("%PDF-1.4 synthetic");
  });

  it.each([
    [{ rcptReply: "550 No such user" }, FAILED, "recipient_rejected"],
    [{ rcptReply: "451 Try later" }, PENDING, "smtp_deferred"],
    [{ dataReply: "554 Rejected as spam" }, FAILED, "provider_rejected"],
    [{ dataReply: "452 Mailbox full" }, PENDING, "smtp_deferred"],
    [{ credentials: ["kim", "other"] as [string, string] }, PENDING, "smtp_login_failed"],
  ])("refusals say whether to retry (%o)", async (changes, state, code) => {
    server.credentials = ["kim", "s3cret"];
    Object.assign(server, changes);
    const result = await new SmtpTransport(account({ username: "kim", password: "s3cret" })).send(message());
    expect([result.state, result.errorCode]).toEqual([state, code]);
  });

  it("fails to connect before anything is sent", async () => {
    let result = await new SmtpTransport(account({ port: 1 })).send(message());
    expect([result.state, result.errorCode]).toEqual([PENDING, "smtp_connection"]);
    // The server offers neither STARTTLS nor a login.
    result = await new SmtpTransport(account({ security: "starttls" })).send(message());
    expect([result.state, result.errorCode]).toEqual([PENDING, "smtp_tls_unavailable"]);
    result = await new SmtpTransport(account({ username: "kim", password: "s3cret" })).send(message());
    expect([result.state, result.errorCode]).toEqual([PENDING, "smtp_login_unavailable"]);
    // TLS with a server that answers without it.
    result = await new SmtpTransport(account({ security: "tls" })).send(message());
    expect([result.state, result.errorCode, result.retryAfter]).toEqual([PENDING, "smtp_tls_failed", 900]);
    expect(server.received).toEqual([]);
  });

  it("never leaves what SMTP cannot send in ASCII unknown", async () => {
    server.credentials = ["kim", "pässword"];
    let result = await new SmtpTransport(account({ username: "kim", password: "pässword" })).send(message());
    expect([result.state, result.errorCode]).toEqual([PENDING, "smtp_login_not_ascii"]);
    result = await new SmtpTransport(account()).send(message({ recipient: "kim@bücher.example.invalid" }));
    expect([result.state, result.errorCode]).toEqual([FAILED, "address_not_ascii"]);
    expect(server.received).toEqual([]);
  });

  it.each([
    ["a blank line", "\r\n"],
    ["a code cut off", "25"],
    ["a reply cut off", "250"],
    ["no code", "Queued\r\n"],
    ["a code run into its text", "451Oops\r\n"],
    ["a code that changes across lines", "250-ok\r\n451 later\r\n"],
  ])("never retries an unclear reply to the content: %s", async (_name, raw) => {
    server.dataRaw = raw;
    const result = await new SmtpTransport(account()).send(message());
    expect(server.received).toHaveLength(1);
    expect([result.state, result.errorCode]).toEqual([UNKNOWN, "provider_outcome_unknown"]);
  });

  it.each([
    // Before the content: nothing was sent, so it is retried.
    ["data", PENDING, "smtp_connection"],
    // After the content: the server may have accepted it.
    ["content", UNKNOWN, "provider_outcome_unknown"],
  ] as const)(
    "loses the connection: unknown only once the content was sent (%s)",
    async (drop, state, code) => {
      server.drop = drop;
      const result = await new SmtpTransport(account()).send(message());
      expect([result.state, result.errorCode]).toEqual([state, code]);
    },
  );
});

describe("the mail server's answer", () => {
  const login = { username: "kim@example.invalid", password: "pass word+1" };
  const base64 = (text: string) => Buffer.from(text).toString("base64");

  it.each([
    [
      "550-5.7.1 Sender address rejected\r\n550 5.7.1\tsee the docs\u0007",
      "550-5.7.1 Sender address rejected 550 5.7.1 see the docs",
    ],
    // The login, as written and as AUTH sends it.
    [`535 ${login.username} ${login.password}`, "535 *** ***"],
    [`535 ${base64(login.username)} ${base64(login.password)}`, "535 *** ***"],
    [`535 AUTH PLAIN ${base64(`\0${login.username}\0${login.password}`)}`, "535 AUTH PLAIN ***"],
    // Hidden before the line is cut.
    [`535 ${"x".repeat(190)}${login.password}`, `535 ${"x".repeat(190)}***`],
    [`535 ${"x".repeat(500)}`, `535 ${"x".repeat(196)}`],
    ["550", "550"],
    // No refusal, or no mail server.
    ["", null],
    ["250 OK", null],
    ["HTTP/1.1 400 Bad Request", null],
    ["4501", null],
  ])("is one line without the login: %j", (reply, expected) => {
    expect(smtpReply(reply, login)).toBe(expected);
  });

  it("works without a login", () => {
    expect(smtpReply("550 No such user", { username: "", password: "" })).toBe("550 No such user");
  });

  it.each([
    [{ greeting: "554 Not from your address" }, "554 Not from your address"],
    [{ authRefusal: "535-Wrong login:\r\n535 not s3cret " }, "535-Wrong login: 535 not ***"],
    [{ rcptReply: "550 No such user" }, "550 No such user"],
    [{ rcptReply: "550" }, "550"],
    [{ dataReply: "452 Mailbox full" }, "452 Mailbox full"],
    [{ greeting: "HTTP/1.1 400 Bad Request" }, null],
    // FTP greets with 220 and refuses EHLO, then MAIL.
    [{ ehloReply: "500 Unknown command", rcptReply: "530 Please login" }, null],
    // The connection ends without an answer.
    [{ drop: "data" as const }, null],
    [{}, null],
  ])("is the one to the last command, and no part of the result (%j)", async (changes, expected) => {
    // A password may end with a space.
    server.credentials = ["kim", "authRefusal" in changes ? "other" : "s3cret "];
    Object.assign(server, changes);
    const username = "ehloReply" in changes ? "" : "kim";
    const transport = new SmtpTransport(account({ username, password: "s3cret " }));
    const result = await transport.send(message());
    expect(smtpReply(transport.lastReply, transport.account)).toBe(expected);
    expect(Object.keys(result).sort()).toEqual(["errorCode", "messageId", "retryAfter", "state"]);
  });
});

describe("quoted-printable", () => {
  it("encodes as Python's quopri does, in lines of at most 76 characters", () => {
    // quopri.encodestring(text.encode(), quotetabs=False) with CRLF line ends.
    expect(quotedPrintable("Umlaute: äöü = gleich \nEnde\t\n")).toBe(
      "Umlaute: =C3=A4=C3=B6=C3=BC =3D gleich=20\r\nEnde=09\r\n",
    );
    const long = quotedPrintable(`${"x".repeat(100)}\n`).split("\r\n");
    expect(long[0]).toBe(`${"x".repeat(75)}=`);
    expect(long[1]).toBe("x".repeat(25));
  });
});
