import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  connectClient,
  connectionOptions,
  prefersTls,
  resetTlsFallbackForTests,
  withLibpqSslModes,
  withTlsFallback,
} from "./client";

const URL_BASE = "postgresql://iam:secret@db.example.invalid:5432/iam";

describe("withLibpqSslModes", () => {
  it("gives sslmode=require and prefer the meaning of PostgreSQL, as in the Django version", () => {
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=require`)).toBe(
      `${URL_BASE}?sslmode=require&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?connect_timeout=5&sslmode=prefer`)).toBe(
      `${URL_BASE}?connect_timeout=5&sslmode=prefer&uselibpqcompat=true`,
    );
    // The host in the query, which URL does not accept.
    expect(withLibpqSslModes("postgresql://iam:secret@/iam?host=db.example.invalid&sslmode=require")).toBe(
      "postgresql://iam:secret@/iam?host=db.example.invalid&sslmode=require&uselibpqcompat=true",
    );
    // A "?" in a value, and verify-ca with its CA.
    expect(withLibpqSslModes(`${URL_BASE}?application_name=iam?preview&sslmode=require`)).toBe(
      `${URL_BASE}?application_name=iam?preview&sslmode=require&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=verify-ca&sslrootcert=/run/ca.pem`)).toBe(
      `${URL_BASE}?sslmode=verify-ca&sslrootcert=/run/ca.pem&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=verify-full&sslmode=require`)).toBe(
      `${URL_BASE}?sslmode=verify-full&sslmode=require&uselibpqcompat=true`,
    );
    // Encrypted, the certificate unchecked.
    const client = new pg.Client({ connectionString: withLibpqSslModes(`${URL_BASE}?sslmode=require`) });
    const { ssl } = (client as unknown as { connectionParameters: { ssl: { rejectUnauthorized?: boolean } } })
      .connectionParameters;
    expect(ssl.rejectUnauthorized).toBe(false);
  });

  it("leaves every other URL as it is", () => {
    for (const url of [
      URL_BASE,
      `${URL_BASE}?sslmode=verify-full`,
      `${URL_BASE}?sslmode=disable`,
      `${URL_BASE}?sslmode=no-verify`,
      `${URL_BASE}?sslmode=require&uselibpqcompat=false`,
      "not a url",
      "not a url?sslmode=verify-full",
      `${URL_BASE}?sslmode=verify-ca`,
      `${URL_BASE}?sslmode=require&sslmode=verify-full`,
    ]) {
      expect(withLibpqSslModes(url)).toBe(url);
    }
  });
});

/**
 * A server that answers PostgreSQL's request for TLS with "no", as a server
 * without TLS does, and notes what each connection asked first.
 */
async function serverWithoutTls() {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.once("data", (data: Buffer) => {
      const tls = data.length >= 8 && data.readInt32BE(0) === 8 && data.readInt32BE(4) === 80877103;
      seen.push(tls ? "tls" : "startup");
      if (tls) socket.write("N");
      else socket.destroy();
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://reimbursement:secret@127.0.0.1:${port}/reimbursement`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("TLS when the URL leaves it to PostgreSQL's default (prefer), as the Django version did", () => {
  afterEach(() => resetTlsFallbackForTests());

  it("is preferred without an sslmode and with sslmode=prefer only", () => {
    expect(prefersTls(URL_BASE, {})).toBe(true);
    expect(prefersTls(`${URL_BASE}?connect_timeout=5&sslmode=prefer`, {})).toBe(true);
    expect(prefersTls("postgresql://iam:secret@/iam?host=/run/postgresql", {})).toBe(true);
    for (const url of [
      `${URL_BASE}?sslmode=disable`,
      `${URL_BASE}?sslmode=require`,
      `${URL_BASE}?sslmode=verify-full`,
      `${URL_BASE}?sslmode=prefer&sslrootcert=/run/ca.pem`,
    ]) {
      expect(prefersTls(url, {})).toBe(false);
    }
    expect(prefersTls(URL_BASE, { PGSSLMODE: "disable" })).toBe(false);
    // The ssl option, not the URL, then decides: unchecked, as libpq's prefer.
    const options = connectionOptions(`${URL_BASE}?sslmode=prefer&connect_timeout=5`);
    expect(options.connectionString).toBe(`${URL_BASE}?connect_timeout=5`);
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("asks for TLS first, then connects without it when the server has none", async () => {
    const server = await serverWithoutTls();
    try {
      // The fake server ends the connection after the startup message.
      await expect(connectClient(server.url)).rejects.toThrow();
      expect(server.seen).toEqual(["tls", "startup"]);
    } finally {
      await server.close();
    }
  });

  it("does the same for the pool, and stops asking after the first refusal", async () => {
    const server = await serverWithoutTls();
    const pool = withTlsFallback(new pg.Pool({ ...connectionOptions(server.url), max: 1 }));
    try {
      await expect(pool.query("select 1")).rejects.toThrow();
      expect(server.seen).toEqual(["tls", "startup"]);
      await expect(pool.query("select 1")).rejects.toThrow();
      expect(server.seen).toEqual(["tls", "startup", "startup"]);
    } finally {
      await pool.end();
      await server.close();
    }
  });

  it("lets every connection refused on its way fall back, not only the first", async () => {
    const server = await serverWithoutTls();
    const pool = withTlsFallback(new pg.Pool({ ...connectionOptions(server.url), max: 5 }));
    try {
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => pool.query("select 1")));
      // The fake server then ends each plain connection; none may fail on the refused TLS.
      for (const result of results) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason.message).not.toBe(
          "The server does not support SSL connections",
        );
      }
      expect(server.seen.filter((step) => step === "tls")).toHaveLength(5);
      expect(server.seen.filter((step) => step === "startup")).toHaveLength(5);
    } finally {
      await pool.end();
      await server.close();
    }
  });

  it("never falls back with sslmode=require, and never asks with sslmode=disable", async () => {
    const server = await serverWithoutTls();
    try {
      await expect(connectClient(`${server.url}?sslmode=require`)).rejects.toThrow(
        "The server does not support SSL connections",
      );
      expect(server.seen).toEqual(["tls"]);
      await expect(connectClient(`${server.url}?sslmode=disable`)).rejects.toThrow();
      expect(server.seen).toEqual(["tls", "startup"]);
    } finally {
      await server.close();
    }
  });
});
