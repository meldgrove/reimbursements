// tests/test_error_reporting.py of the Django version, and the redacted HTTP
// 500 log of tests/test_operations.py. Sentry runs as in production (started
// by instrument.ts) in a child process and reports to a local stand-in for
// Sentry. Not carried over: the Django-only cases (library loggers that
// format messages before logging, Django's DisallowedHost log); the redaction
// itself is tested in packages/shared/src/error-reports.test.ts.
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "./paths";
import { childEnvironment } from "./services/documents";

const run = promisify(execFile);
const PRIVATE = /synthetic_private/i;

/** Sentry's stand-in: keeps the events and the trace data (spans, transactions) of every envelope. */
let events: Array<Record<string, unknown>> = [];
let traces: Array<Record<string, unknown>> = [];
let server: http.Server;
let dsn: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const lines = Buffer.concat(chunks).toString("utf8").split("\n");
      for (let index = 1; index < lines.length - 1; index += 1) {
        try {
          const header = JSON.parse(lines[index]!) as { type?: string };
          if (header.type === "event") events.push(JSON.parse(lines[index + 1]!) as Record<string, unknown>);
          if (header.type === "span" || header.type === "transaction")
            traces.push(JSON.parse(lines[index + 1]!) as Record<string, unknown>);
        } catch {
          // Payload lines that are no item header.
        }
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  dsn = `http://public@127.0.0.1:${(server.address() as { port: number }).port}/1`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const BASE = {
  PATH: process.env.PATH ?? "",
  DJANGO_DEBUG: "1",
  DEPLOYMENT_ENV: "development",
  PRIVATE_STORAGE_ROOT: "/tmp/reimbursements-error-reporting",
  LOG_LEVEL: "info",
};

/** Runs the child in `mode` with `environment`: its answer and its log lines. */
async function child(mode: string, environment: Record<string, string>) {
  events = [];
  traces = [];
  const { stdout, stderr } = await run(
    process.execPath,
    ["--import", "tsx", path.join(SERVER_ROOT, "src/test/error-reporting-child.ts"), mode],
    { cwd: SERVER_ROOT, env: { ...BASE, ...environment }, timeout: 60_000 },
  );
  const line = stderr.split("\n").find((entry) => entry.startsWith("RESULT "));
  return { answer: line ? (JSON.parse(line.slice(7)) as unknown) : undefined, logs: stdout };
}

describe("error reporting", () => {
  it("reports a request failure with its stack, without request data", async () => {
    const { answer, logs } = await child("request", {
      SENTRY_DSN: dsn,
      APP_ROLE: "web",
      // The database's refusal names the database: a message with private text.
      DATABASE_URL: "postgresql://reimbursement:reimbursement@127.0.0.1:55468/synthetic_private_db",
    });
    expect(answer).toMatchObject({ status: 500 });
    const [event] = events;
    expect(event).toBeDefined();
    const [exception] = (event!.exception as { values: Array<Record<string, unknown>> }).values;
    expect(exception!.type).toBeTruthy();
    expect(exception).not.toHaveProperty("value");
    expect((exception!.stacktrace as { frames: unknown[] }).frames.length).toBeGreaterThan(0);
    expect((event!.tags as Record<string, string>).role).toBe("web");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("user");
    expect(JSON.stringify(event)).not.toMatch(PRIVATE);
    // The log of the failure (tests/test_operations.py): its request ID and route, no values.
    const requestId = (answer as { requestId: string }).requestId;
    expect(logs).toContain("unhandled error");
    expect(logs).toContain(requestId);
    expect(logs).not.toMatch(PRIVATE);
  }, 90_000);

  it("keeps the message of an application log error and drops the exception's value", async () => {
    await child("log", { SENTRY_DSN: dsn });
    const [event] = events;
    expect(JSON.stringify(event)).toContain("job_failed");
    expect(JSON.stringify(event)).not.toMatch(PRIVATE);
  }, 90_000);

  it("traces requests by their route pattern, never by their path", async () => {
    const { answer } = await child("trace", {
      SENTRY_DSN: dsn,
      SENTRY_TRACES_SAMPLE_RATE: "1",
      APP_ROLE: "web",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://reimbursement:reimbursement@127.0.0.1:55468/reimbursements",
    });
    expect((answer as { statuses: number[] }).statuses).toHaveLength(5);
    const sent = JSON.stringify(traces);
    // The route patterns arrive, also for requests no route matched.
    expect(sent).toContain("GET /api/v1/public/forms/:slug");
    expect(sent).toContain("GET /*");
    expect(sent).not.toMatch(PRIVATE);
    expect(sent).not.toContain("11111111-1111-4111-8111-111111111111");
  }, 90_000);

  it("reports an operator command's failure, tagged with the command, without its message", async () => {
    events = [];
    traces = [];
    // As the image starts `cli`: Sentry first (docker-entrypoint.sh).
    const failed = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        path.join(SERVER_ROOT, "src/instrument.ts"),
        path.join(SERVER_ROOT, "src/test/cli-child.ts"),
        "fail-privately",
      ],
      { cwd: SERVER_ROOT, env: { ...BASE, SENTRY_DSN: dsn }, timeout: 60_000 },
    ).catch((error: { code?: number }) => error);
    expect((failed as { code?: number }).code).toBe(1);
    const [event] = events;
    expect(event).toBeDefined();
    expect((event!.tags as Record<string, string>).role).toBe("fail-privately");
    expect(JSON.stringify(event)).toContain("command_failed");
    expect(JSON.stringify(event)).not.toMatch(PRIVATE);
  }, 90_000);

  it("gives document children no tracing variables", () => {
    const environment = childEnvironment("/tmp/workspace");
    expect(Object.keys(environment).some((name) => name.toUpperCase().includes("SENTRY"))).toBe(false);
  });

  it("sends no tracing headers with outgoing requests", async () => {
    const { answer } = await child("fetch", { SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: "1" });
    const headers = answer as Record<string, unknown>;
    expect(Object.keys(headers).length).toBeGreaterThan(0);
    expect(headers).not.toHaveProperty("sentry-trace");
    expect(headers).not.toHaveProperty("baggage");
  }, 90_000);

  it.each([
    [{}, null],
    [{ SENTRY_DSN: "DSN" }, { environment: "development", release: null }],
    [
      { SENTRY_DSN: "DSN", APP_VERSION: "1.2.3" },
      { environment: "development", release: "reimbursements@1.2.3" },
    ],
    [
      { SENTRY_DSN: "DSN", SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "abc123", APP_VERSION: "1.2.3" },
      { environment: "staging", release: "abc123" },
    ],
  ])(
    "starts only with a DSN (%o)",
    async (variables, expected) => {
      const environment = Object.fromEntries(
        Object.entries(variables).map(([name, value]) => [name, value === "DSN" ? dsn : value]),
      );
      const { answer } = await child("options", environment);
      expect(answer).toEqual(expected);
    },
    90_000,
  );
});
