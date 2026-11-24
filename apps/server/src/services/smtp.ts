/**
 * SMTP: the transport adapter for an SMTP server set up under Admin > Email
 * (portal/services/smtp.py of the Django version, which used Python's smtplib; this
 * client speaks the same commands in the same order).
 *
 * The server's acceptance of a message is the last thing the app learns about it: SMTP
 * reports neither delivery nor bounces back to the app, and bounces go to the sender
 * address. So an accepted message counts as delivered, and nothing is reconciled later.
 *
 * Every failure before the message content is sent is definite and retried later, as with
 * any provider that refuses before acceptance. A failure while sending the content leaves
 * the outcome unknown, because the server may have accepted the message.
 */
import { createHmac, randomInt } from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { APP_NAME } from "../constants";
import type { SmtpAccount } from "./email-connection";
import {
  DELIVERED,
  FAILED,
  PENDING,
  UNKNOWN,
  sendResult,
  type Message,
  type SendResult,
  type Transport,
} from "./transport";

export const TIMEOUT_SECONDS = 30;
/** smtplib's longest reply line. */
const MAX_LINE = 8192;
/** smtplib's limit of AUTH challenges. */
const MAX_CHALLENGES = 5;

/** The server refused before the message content was sent. Holds the error code. */
export class Refused extends Error {
  /** `Session.lastReply` at the refusal. */
  lastReply = "";

  constructor(
    readonly code: string,
    readonly retryAfter = 60,
  ) {
    super(code);
    this.name = "Refused";
  }
}

/** A command that SMTP without SMTPUTF8 cannot carry: it holds other than ASCII characters. */
class NotAscii extends Error {}
/** The server refused the login (smtplib's SMTPAuthenticationError). */
class LoginRefused extends Error {}
/** The TLS handshake failed (ssl.SSLError). */
class TlsFailed extends Error {}

type Reply = { code: number; text: string };

const isAscii = (value: string) => /^[\x00-\x7f]*$/.test(value); // eslint-disable-line no-control-regex

/** One SMTP session on a socket: commands out, replies in. */
class Session {
  private buffer = Buffer.alloc(0);
  private ended: Error | null = null;
  private notify: (() => void) | null = null;
  /** The extensions of the last EHLO answer, by lower-case keyword (smtplib's esmtp_features). */
  features = new Map<string, string>();
  /** The server's reply to what was sent last, as it wrote it; "" without one. For `smtpReply`. */
  lastReply = "";
  /** A server that refuses EHLO is no mail server (FTP greets and refuses alike): never quoted. */
  private ehloRefused = false;

  constructor(
    private socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    this.listen(socket);
  }

  private listen(socket: net.Socket) {
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("timeout", () => socket.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    socket.on("error", (error) => this.end(error));
    socket.on("close", () => this.end(new Error("Connection unexpectedly closed")));
  }

  private end(error: Error) {
    this.ended ??= error;
    this.wake();
  }

  private wake() {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }

  /** The next line with its line end; a last line without one when the server closed. */
  private async line(): Promise<Buffer> {
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end >= 0 || this.buffer.length > MAX_LINE) {
        const length = end >= 0 ? end + 1 : this.buffer.length;
        const line = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return line;
      }
      if (this.ended) {
        if (this.buffer.length) {
          const line = this.buffer;
          this.buffer = Buffer.alloc(0);
          return line;
        }
        throw this.ended;
      }
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }

  /**
   * A complete reply (smtplib's getreply). `complete`: only a well-formed reply
   * counts; a line the server cut off by closing (without its line end), a line
   * that is not a code followed by a space, "-" or the line end, and a code that
   * changes across the lines are an error, not a reply.
   */
  async reply({ complete = false } = {}): Promise<Reply> {
    const lines: string[] = [];
    let raw = "";
    let first: string | undefined;
    for (;;) {
      const line = await this.line();
      if (line.length > MAX_LINE) throw new Error("Line too long.");
      if (complete) {
        const head = /^(\d{3})(?:[ -]|\r?\n$)/.exec(line.toString("latin1"));
        if (line.at(-1) !== 0x0a || !head || (first ?? head[1]) !== head[1]) throw new Error("Unclear reply");
        first = head[1];
      }
      raw += line.toString("utf8");
      lines.push(
        line
          .subarray(4)
          .toString("latin1")
          .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""),
      );
      const code = /^\d{3}$/.test(line.subarray(0, 3).toString("latin1"))
        ? Number(line.subarray(0, 3).toString("latin1"))
        : Number.NaN;
      if (Number.isNaN(code)) return { code: -1, text: lines.join("\n") };
      if (line.subarray(3, 4).toString("latin1") !== "-") {
        this.lastReply = this.ehloRefused ? "" : raw.replace(/\r?\n$/, "");
        return { code, text: lines.join("\n") };
      }
    }
  }

  send(content: Buffer | string) {
    this.lastReply = "";
    if (this.ended) throw this.ended;
    this.socket.write(content);
  }

  /** Sends a command line and reads its reply. Nothing is sent of a command that is not ASCII. */
  async command(text: string): Promise<Reply> {
    if (!isAscii(text)) throw new NotAscii(text);
    this.send(`${text}\r\n`);
    return this.reply();
  }

  /** EHLO, and the extensions the server offers. */
  async ehlo(): Promise<Reply> {
    this.features = new Map();
    const reply = await this.command(`ehlo ${localHostname()}`);
    if (reply.code === -1 && !reply.text) throw new Error("Server not connected");
    if (reply.code !== 250) {
      this.ehloRefused = true;
      this.lastReply = "";
      return reply;
    }
    for (const line of reply.text.split("\n").slice(1)) {
      const oldStyle = /^auth=(.*)/i.exec(line);
      if (oldStyle) {
        this.features.set("auth", `${this.features.get("auth") ?? ""} ${oldStyle[1]}`);
        continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*) ?/.exec(line);
      if (!match) continue;
      const feature = match[1]!.toLowerCase();
      const params = line.slice(match[1]!.length).trim();
      this.features.set(
        feature,
        feature === "auth" ? `${this.features.get("auth") ?? ""} ${params}` : params,
      );
    }
    return reply;
  }

  /** Continues the session encrypted (after STARTTLS, or at once for TLS). */
  async encrypt(host: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("timeout");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buffer = Buffer.alloc(0);
    let timedOut = false;
    try {
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({ socket: plain, host, servername: net.isIP(host) ? undefined : host });
        plain.setTimeout(this.timeoutMs, () => {
          timedOut = true;
          socket.destroy(new Error("timed out"));
        });
        socket.once("secureConnect", () => resolve(socket));
        socket.once("error", reject);
      });
      plain.setTimeout(0);
      this.socket = secure;
      this.listen(secure);
    } catch (error) {
      plain.destroy();
      // A timeout is a connection failure, as for Python's socket.timeout; anything else
      // that ends the handshake is ssl.SSLError's.
      const failure = timedOut ? new Error("timed out") : new TlsFailed((error as Error).message);
      this.end(failure);
      throw failure;
    }
  }

  close() {
    this.socket.destroy();
  }
}

/** The name this machine introduces itself with (smtplib's socket.getfqdn()). */
function localHostname(): string {
  return os.hostname() || "localhost";
}

function connectSocket(account: SmtpAccount, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: account.host, port: account.port });
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** The pieces of a login with `mechanism`, as smtplib's auth_* methods answer challenges. */
async function authenticate(session: Session, mechanism: string, username: string, password: string) {
  const encode = (value: string) => {
    if (!isAscii(value)) throw new NotAscii("login");
    return Buffer.from(value, "latin1").toString("base64");
  };
  let reply: Reply;
  let challenges: number;
  const answer = (challenge: Buffer): string => {
    if (mechanism === "CRAM-MD5") {
      if (!isAscii(password)) throw new NotAscii("login");
      return `${username} ${createHmac("md5", Buffer.from(password, "latin1")).update(challenge).digest("hex")}`;
    }
    if (mechanism === "PLAIN") return `\0${username}\0${password}`;
    return challenges < 2 ? username : password;
  };
  if (mechanism === "CRAM-MD5") {
    reply = await session.command(`AUTH ${mechanism}`);
    challenges = 0;
  } else {
    const initial = mechanism === "PLAIN" ? `\0${username}\0${password}` : username;
    reply = await session.command(`AUTH ${mechanism} ${encode(initial)}`);
    challenges = 1;
  }
  while (reply.code === 334) {
    challenges += 1;
    const response = encode(answer(Buffer.from(reply.text, "base64")));
    reply = await session.command(response);
    if (challenges > MAX_CHALLENGES) throw new Error("Server AUTH mechanism infinite loop.");
  }
  if (reply.code !== 235 && reply.code !== 503) throw new LoginRefused(String(reply.code));
}

/** smtplib's login: the mechanisms both sides know, CRAM-MD5 first; the last refusal counts. */
async function login(session: Session, username: string, password: string) {
  const advertised = (session.features.get("auth") ?? "").split(/\s+/).filter(Boolean);
  const mechanisms = ["CRAM-MD5", "PLAIN", "LOGIN"].filter((mechanism) => advertised.includes(mechanism));
  if (!mechanisms.length) throw new Error("No suitable authentication method found.");
  let refused: Error | null = null;
  for (const mechanism of mechanisms) {
    try {
      await authenticate(session, mechanism, username, password);
      return;
    } catch (error) {
      if (!(error instanceof LoginRefused)) throw error;
      refused = error;
    }
  }
  throw refused!;
}

/**
 * A session with `account`'s server, encrypted as set up and signed in.
 * Throws Refused when that fails.
 */
async function connect(account: SmtpAccount, timeoutMs: number): Promise<Session> {
  let session: Session | null = null;
  try {
    session = new Session(await connectSocket(account, timeoutMs), timeoutMs);
    if (account.security === "tls") await session.encrypt(account.host);
    const greeting = await session.reply();
    if (greeting.code !== 220) throw new Error(`Greeting ${greeting.code}`);
    await session.ehlo();
    if (account.security === "starttls") {
      if (!session.features.has("starttls")) throw new Refused("smtp_tls_unavailable", 900);
      const reply = await session.command("STARTTLS");
      if (reply.code !== 220) throw new Error(`STARTTLS ${reply.code}`);
      await session.encrypt(account.host);
      await session.ehlo();
    }
    if (account.username) {
      if (!session.features.has("auth")) throw new Refused("smtp_login_unavailable", 900);
      try {
        await login(session, account.username, account.password);
      } catch (error) {
        // smtplib sends the login in ASCII only.
        if (error instanceof NotAscii) throw new Refused("smtp_login_not_ascii", 900);
        throw error;
      }
    }
    return session;
  } catch (error) {
    let refused: Refused;
    if (error instanceof Refused) refused = error;
    else if (error instanceof LoginRefused) refused = new Refused("smtp_login_failed", 900);
    else if (error instanceof TlsFailed) refused = new Refused("smtp_tls_failed", 900);
    else refused = new Refused("smtp_connection");
    if (session) {
      refused.lastReply = session.lastReply;
      await close(session);
    }
    throw refused;
  }
}

/** QUIT, then the connection closes; failures do not matter any more. */
async function close(session: Session) {
  try {
    await session.command("quit");
  } catch {
    // closed already
  }
  session.close();
}

/**
 * The mail server's own answer to a failed test email, for the admin who sent it: one
 * line, without the login, at most 200 characters. null when `reply` is no refusal, or
 * what answered is no mail server (its text is never quoted). Never store or log it.
 */
export function smtpReply(
  reply: string,
  { username, password }: Pick<SmtpAccount, "username" | "password">,
): string | null {
  if (!/^[45]\d\d(?:[ -]|$)/.test(reply)) return null;
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const parts = [username, password].filter(Boolean);
  const hidden = [...parts, ...parts.map(base64), base64(`\0${username}\0${password}`)].sort(
    (a, b) => b.length - a.length,
  );
  let text = reply;
  for (const secret of hidden) text = text.replaceAll(secret, "***");
  return text
    .replace(/[\p{C}\s]+/gu, " ")
    .trim()
    .slice(0, 200);
}

/** The result of a refusal with SMTP reply `code`: 5xx is permanent, 4xx temporary. */
function refusal(code: number): SendResult {
  if (code >= 500) return sendResult(FAILED, { errorCode: "provider_rejected" });
  return sendResult(PENDING, { errorCode: "smtp_deferred", retryAfter: 300 });
}

// -- The message in seven bits -----------------------------------------------------------

/** An RFC 2047 encoded word, in pieces of at most 75 characters, when `value` is not printable ASCII. */
function headerText(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let piece = "";
  for (const character of clean) {
    if (Buffer.byteLength(piece + character, "utf8") > 45) {
      words.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece) words.push(piece);
  return words.map((word) => `=?utf-8?b?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** Quoted-printable lines of at most 76 characters (RFC 2045), with CRLF line ends. */
export function quotedPrintable(text: string): string {
  const lines = Buffer.from(text.replace(/\r\n|\r/g, "\n"), "utf8")
    .toString("latin1")
    .split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines
    .map((line) => {
      const tokens = [...line].map((character, index) => {
        const byte = character.charCodeAt(0);
        const last = index === line.length - 1;
        if ((byte === 0x20 || byte === 0x09) && !last) return character;
        if (byte >= 33 && byte <= 126 && byte !== 61) return character;
        return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      });
      const out: string[] = [];
      let current = "";
      for (const token of tokens) {
        if (current.length + token.length > 75) {
          out.push(`${current}=`);
          current = "";
        }
        current += token;
      }
      out.push(current);
      return out.join("\r\n");
    })
    .map((line) => `${line}\r\n`)
    .join("");
}

function base64Lines(content: Uint8Array): string {
  return (
    Buffer.from(content)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

/** The text part: seven-bit lines as they are, otherwise quoted-printable. */
function textPart(text: string): string {
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (isAscii(text) && lines.every((line) => line.length <= 78)) {
    return [
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      lines.map((line) => `${line}\r\n`).join(""),
    ].join("\r\n");
  }
  return [
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(text),
  ].join("\r\n");
}

/**
 * The complete message as an SMTP server receives it: seven-bit content with CRLF line
 * ends, From with the app's name, Date and a Message-ID on the sender's domain.
 */
export function smtpMessage(message: Message, now = new Date()): Buffer {
  const domain = message.sender.slice(message.sender.lastIndexOf("@") + 1) || localHostname();
  const headers = [
    `From: ${headerText(APP_NAME)} <${message.sender}>`,
    `To: ${headerText(message.recipient)}`,
    `Subject: ${headerText(message.subject)}`,
    `Reply-To: ${headerText(message.replyTo)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${now.getTime()}.${process.pid}.${randomInt(2 ** 47)}@${headerText(domain)}>`,
    "MIME-Version: 1.0",
  ];
  if (message.attachment === undefined || message.attachment === null) {
    return Buffer.from([...headers, textPart(message.text)].join("\r\n"), "latin1");
  }
  const boundary = `===============${randomInt(2 ** 47)}==`;
  const filename = (message.filename ?? "").replace(/["\r\n]/g, "_");
  const attachment = [
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${headerText(filename)}"`,
    "",
    `${base64Lines(message.attachment)}\r\n`,
  ].join("\r\n");
  return Buffer.from(
    [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      textPart(message.text),
      `--${boundary}`,
      attachment,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    "latin1",
  );
}

/** Deployment transport: an SMTP server. */
export class SmtpTransport implements Transport {
  /** `Session.lastReply` when the last `send` ended. */
  lastReply = "";

  constructor(
    readonly account: SmtpAccount,
    readonly timeoutSeconds = TIMEOUT_SECONDS,
  ) {}

  async send(message: Message): Promise<SendResult> {
    const content = smtpMessage(message);
    let session: Session;
    try {
      session = await connect(this.account, this.timeoutSeconds * 1000);
    } catch (error) {
      if (error instanceof Refused) {
        this.lastReply = error.lastReply;
        return sendResult(PENDING, { errorCode: error.code, retryAfter: error.retryAfter });
      }
      throw error;
    }
    try {
      return await transmit(session, message, content);
    } finally {
      this.lastReply = session.lastReply;
      await close(session);
    }
  }
}

async function transmit(session: Session, message: Message, content: Buffer): Promise<SendResult> {
  let code: number;
  try {
    code = (await session.command(`mail from:<${message.sender}>`)).code;
    if (code !== 250) return sendResult(PENDING, { errorCode: "smtp_sender_refused", retryAfter: 900 });
    code = (await session.command(`rcpt to:<${message.recipient}>`)).code;
    if (code !== 250 && code !== 251) {
      if (code >= 500) return sendResult(FAILED, { errorCode: "recipient_rejected" });
      return refusal(code);
    }
    code = (await session.command("data")).code;
  } catch (error) {
    // Commands go out in ASCII only; the server received nothing of this one.
    if (error instanceof NotAscii) return sendResult(FAILED, { errorCode: "address_not_ascii" });
    return sendResult(PENDING, { errorCode: "smtp_connection", retryAfter: 60 });
  }
  if (code !== 354) return refusal(code);
  // As smtplib's data(): a line that starts with a dot gets a second one.
  let stuffed = content.toString("latin1").replace(/(^|\n)\./g, "$1..");
  if (!stuffed.endsWith("\r\n")) stuffed += "\r\n";
  try {
    session.send(Buffer.from(`${stuffed}.\r\n`, "latin1"));
    code = (await session.reply({ complete: true })).code;
  } catch {
    return sendResult(UNKNOWN, { errorCode: "provider_outcome_unknown" });
  }
  // The server has the content: only a complete, well-formed reply with a valid code
  // decides. Anything else (a blank, cut-off or malformed reply, or one whose code changes
  // across its lines) may follow an accepted message, so it is unknown, never retried
  // (smtplib would retry a blank or malformed one).
  if (code >= 200 && code < 300) return sendResult(DELIVERED, { messageId: `smtp-${message.attemptId}` });
  if (code >= 400 && code < 600) return refusal(code);
  return sendResult(UNKNOWN, { errorCode: "provider_outcome_unknown" });
}
