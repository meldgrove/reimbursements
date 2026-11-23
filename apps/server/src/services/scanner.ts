/**
 * Malware scanning of uploaded source files.
 *
 * Two adapters sit behind `configuredScanner()`: ClamAV in deployments and a no-op
 * scanner for local development. A scanner outage never counts as a clean scan.
 */
import { createReadStream } from "node:fs";
import net from "node:net";
import { config } from "../config";

/** Every code a scan can fail with; each has a participant message (intake.ts). */
export const SCAN_FAILURE_CODES = [
  "malware_detected",
  "scanner_unavailable",
  "scanner_configuration",
] as const;

/** `code` is participant-facing; `retryable` failures leave the upload pending. */
export class ScanError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "ScanError";
  }
}

export interface Scanner {
  scan(path: string): Promise<void>;
  ready(): Promise<boolean>;
}

/** A TCP connection to clamd with a timeout on connecting and on every wait. */
function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function write(socket: net.Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** Reads until a NUL byte, `limit` bytes or the end of the connection. */
function readReply(socket: net.Socket, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let reply = Buffer.alloc(0);
    const finish = () => {
      socket.removeAllListeners("data");
      resolve(reply);
    };
    socket.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.includes(0) || reply.length >= limit) finish();
    });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", reject);
  });
}

function trimReply(reply: Buffer): string {
  return reply.toString("latin1").replace(/^[\0\r\n]+|[\0\r\n]+$/g, "");
}

export class ClamAVScanner implements Scanner {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {}

  async scan(path: string): Promise<void> {
    let reply: Buffer;
    try {
      const socket = await connect(this.host, this.port, 30_000);
      try {
        const replied = readReply(socket, 4096);
        await write(socket, Buffer.from("zINSTREAM\0", "latin1"));
        for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
          const length = Buffer.alloc(4);
          length.writeUInt32BE((chunk as Buffer).length);
          await write(socket, Buffer.concat([length, chunk as Buffer]));
        }
        await write(socket, Buffer.alloc(4));
        reply = await replied;
      } finally {
        socket.destroy();
      }
    } catch {
      throw new ScanError("scanner_unavailable", true);
    }
    if (trimReply(reply) === "stream: OK") return;
    if (reply.includes(" FOUND")) throw new ScanError("malware_detected");
    throw new ScanError("scanner_unavailable", true);
  }

  async ready(): Promise<boolean> {
    try {
      const socket = await connect(this.host, this.port, 2000);
      try {
        const replied = readReply(socket, 32);
        await write(socket, Buffer.from("zPING\0", "latin1"));
        return trimReply((await replied).subarray(0, 32)) === "PONG";
      } finally {
        socket.destroy();
      }
    } catch {
      return false;
    }
  }
}

/** Local development only. */
export class DisabledScanner implements Scanner {
  async scan(): Promise<void> {}

  async ready(): Promise<boolean> {
    return true;
  }
}

export class MisconfiguredScanner implements Scanner {
  async scan(): Promise<void> {
    throw new ScanError("scanner_configuration");
  }

  async ready(): Promise<boolean> {
    return false;
  }
}

export function configuredScanner(): Scanner {
  const settings = config();
  if (settings.UPLOAD_SCANNER === "clamav")
    return new ClamAVScanner(settings.CLAMAV_HOST, settings.CLAMAV_PORT);
  if (settings.UPLOAD_SCANNER === "disabled" && settings.isDevelopment) return new DisabledScanner();
  return new MisconfiguredScanner();
}

export function scanFile(path: string): Promise<void> {
  return configuredScanner().scan(path);
}

export function scannerReady(): Promise<boolean> {
  return configuredScanner().ready();
}
