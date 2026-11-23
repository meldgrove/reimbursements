import net from "node:net";

/**
 * Enough SMTP for the app's client: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, RSET and QUIT
 * (SmtpHandler of tests/test_email_settings.py in the Django version). Tests change its
 * answers and read what it received.
 */
export class FakeSmtpServer {
  commands: string[] = [];
  received: Buffer[] = [];
  envelope: { from?: string; to?: string } = {};
  credentials: [string, string] | null = null;
  /** "data": close on DATA; "content": close after reading the content, before the answer. */
  drop: "" | "data" | "content" = "";
  rcptReply = "250 OK";
  dataReply = "250 Queued";
  /** Written as is after the content instead of `dataReply`, then the server closes. */
  dataRaw: string | null = null;
  private readonly server = net.createServer((socket) => this.handle(socket));
  private readonly sockets = new Set<net.Socket>();

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this;
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let buffer = Buffer.alloc(0);
    let content: Buffer | null = null;
    reply("220 fake.example.invalid ESMTP");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const raw = buffer.subarray(0, end + 1);
        buffer = buffer.subarray(end + 1);
        if (content !== null) {
          if (raw.toString("latin1") !== ".\r\n") {
            content = Buffer.concat([content, raw]);
            continue;
          }
          this.received.push(content);
          content = null;
          if (this.drop === "content") {
            socket.destroy();
            return;
          }
          if (this.dataRaw !== null) {
            socket.end(this.dataRaw);
            return;
          }
          reply(this.dataReply);
          continue;
        }
        const command = raw.toString("utf8").replace(/\r?\n$/, "");
        const verb = command.split(" ", 1)[0]!.toUpperCase();
        this.commands.push(verb);
        if (verb === "EHLO") {
          if (this.credentials) {
            reply("250-fake.example.invalid");
            reply("250 AUTH PLAIN");
          } else reply("250 fake.example.invalid");
        } else if (verb === "AUTH") {
          const [, user, password] = Buffer.from(command.split(" ")[2] ?? "", "base64")
            .toString("utf8")
            .split("\0");
          const ok = this.credentials && user === this.credentials[0] && password === this.credentials[1];
          reply(ok ? "235 Authenticated" : "535 Authentication failed");
        } else if (verb === "MAIL") {
          this.envelope.from = command;
          reply("250 OK");
        } else if (verb === "RCPT") {
          this.envelope.to = command;
          reply(this.rcptReply);
        } else if (verb === "DATA") {
          if (this.drop === "data") {
            socket.destroy();
            return;
          }
          reply("354 Go ahead");
          content = Buffer.alloc(0);
        } else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
          return;
        } else reply("250 OK");
      }
    });
  }
}

/** The headers and parts of a message the fake server received (enough MIME for the tests). */
export function parseMessage(raw: Buffer) {
  const text = raw.toString("latin1");
  const split = (block: string) => {
    const at = block.indexOf("\r\n\r\n");
    const head = block.slice(0, at).replace(/\r\n[ \t]+/g, " ");
    const headers = new Map<string, string>();
    for (const line of head.split("\r\n")) {
      const colon = line.indexOf(":");
      headers.set(line.slice(0, colon).toLowerCase(), decodeWords(line.slice(colon + 1).trim()));
    }
    return { headers, body: block.slice(at + 4) };
  };
  const message = split(text);
  const boundary = /boundary="([^"]+)"/.exec(message.headers.get("content-type") ?? "")?.[1];
  const parts = boundary
    ? message.body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => split(part.replace(/^\r\n/, "")))
    : [message];
  return {
    headers: message.headers,
    parts: parts.map((part) => ({
      headers: part.headers,
      content: decodeBody(
        part.body.replace(/\r\n$/, ""),
        part.headers.get("content-transfer-encoding") ?? "",
      ),
    })),
  };
}

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?utf-8\?b\?([^?]*)\?=/gi, (_, data: string) => Buffer.from(data, "base64").toString("utf8"));
}

function decodeBody(body: string, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body.replace(/\r\n/g, ""), "base64");
  if (encoding === "quoted-printable") {
    const joined = body.replace(/=\r\n/g, "");
    const bytes: number[] = [];
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === "=") {
        bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
      } else bytes.push(joined.charCodeAt(index));
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, "latin1");
}
