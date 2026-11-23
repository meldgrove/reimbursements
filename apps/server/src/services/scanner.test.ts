/** Malware scanning through clamd (tests/test_scanner.py). */
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { overrideConfigForTests } from "../config";
import { ClamAVScanner, ScanError, configuredScanner } from "./scanner";

/** Speaks the clamd zINSTREAM and zPING protocol with a scripted reply. */
class FakeClamAV {
  received = Buffer.alloc(0);
  readonly server: net.Server;
  readonly ready: Promise<number>;

  constructor(readonly reply: Buffer) {
    this.server = net.createServer((connection) => {
      connection.on("data", (part: Buffer) => {
        this.received = Buffer.concat([this.received, part]);
        const done =
          this.received.subarray(-4).equals(Buffer.alloc(4)) || this.received.equals(Buffer.from("zPING\0"));
        if (done) connection.end(this.reply);
      });
    });
    this.ready = new Promise((resolve) =>
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port)),
    );
  }

  close() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function source(): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "scan-")), "receipt.pdf");
  writeFileSync(file, "synthetic receipt");
  return file;
}

async function failure(promise: Promise<unknown>): Promise<ScanError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ScanError) return error;
    throw error;
  }
  throw new Error("The scan passed");
}

describe("scanner", () => {
  it("a clean stream passes and sends the file's bytes", async () => {
    const clamd = new FakeClamAV(Buffer.from("stream: OK\0"));
    await new ClamAVScanner("127.0.0.1", await clamd.ready).scan(source());
    await clamd.close();
    expect(clamd.received.subarray(0, 10).toString()).toBe("zINSTREAM\0");
    expect(clamd.received.includes("synthetic receipt")).toBe(true);
  });

  it("a detection is a terminal failure", async () => {
    const clamd = new FakeClamAV(Buffer.from("stream: Eicar-Test-Signature FOUND\0"));
    const error = await failure(new ClamAVScanner("127.0.0.1", await clamd.ready).scan(source()));
    await clamd.close();
    expect([error.code, error.retryable]).toEqual(["malware_detected", false]);
  });

  it.each([Buffer.from("stream: ERROR\0"), Buffer.alloc(0)])(
    "an unexpected reply is never a clean scan",
    async (reply) => {
      const clamd = new FakeClamAV(reply);
      const error = await failure(new ClamAVScanner("127.0.0.1", await clamd.ready).scan(source()));
      await clamd.close();
      expect([error.code, error.retryable]).toEqual(["scanner_unavailable", true]);
    },
  );

  it("a ping reports readiness", async () => {
    const clamd = new FakeClamAV(Buffer.from("PONG\0"));
    expect(await new ClamAVScanner("127.0.0.1", await clamd.ready).ready()).toBe(true);
    await clamd.close();
    const unused = net.createServer();
    const port = await new Promise<number>((resolve) =>
      unused.listen(0, "127.0.0.1", () => resolve((unused.address() as net.AddressInfo).port)),
    );
    await new Promise<void>((resolve) => unused.close(() => resolve()));
    expect(await new ClamAVScanner("127.0.0.1", port).ready()).toBe(false);
  });

  it("the disabled scanner needs development mode", async () => {
    overrideConfigForTests({ UPLOAD_SCANNER: "disabled", isDevelopment: false });
    const error = await failure(configuredScanner().scan(source()));
    expect(error.code).toBe("scanner_configuration");
    expect(await configuredScanner().ready()).toBe(false);
  });
});
