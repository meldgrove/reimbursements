/**
 * A process with Sentry started as in production (instrument.ts), for the
 * error reporting tests (error-reporting.int.test.ts). Its answers go to
 * stderr as `RESULT <json>`; the app's logs stay on stdout.
 *
 *   node --import tsx src/test/error-reporting-child.ts <options|request|log|trace|fetch>
 */
await import("../instrument");
const Sentry = await import("@sentry/node");

const PRIVATE = "SYNTHETIC_PRIVATE_IBAN_AND_RECEIPT";
const answer = (value: unknown) => process.stderr.write(`RESULT ${JSON.stringify(value)}\n`);
const mode = process.argv[2];

if (mode === "options") {
  const client = Sentry.getClient();
  const options = client?.getOptions();
  answer(options ? { environment: options.environment, release: options.release ?? null } : null);
} else if (mode === "request") {
  const { createApp } = await import("../http/app");
  const response = await createApp().request("/f/SYNTHETIC_PRIVATE_PATH/?iban=SYNTHETIC_PRIVATE_QUERY", {
    headers: { "x-request-id": "SYNTHETIC_PRIVATE_HEADER", cookie: "sessionid=SYNTHETIC_PRIVATE_COOKIE" },
  });
  answer({ status: response.status, requestId: response.headers.get("x-request-id") });
} else if (mode === "log") {
  const { logger } = await import("../logger");
  try {
    throw Object.assign(new Error(PRIVATE), { code: "EIO", syscall: "open" });
  } catch (error) {
    logger.error({ err: error, job: 7, kind: "render" }, "job_failed");
  }
  answer({ logged: true });
} else if (mode === "trace") {
  // Requests through a real server, as in production, so the HTTP integration traces them.
  const { createApp } = await import("../http/app");
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: createApp().fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const statuses: number[] = [];
  for (const path of [
    "/f/synthetic_private_slug/?iban=SYNTHETIC_PRIVATE_QUERY",
    "/api/v1/public/forms/synthetic_private_slug",
    "/received/11111111-1111-4111-8111-111111111111/",
    "/synthetic_private_unmatched/path",
    "/api/v1/synthetic_private_unmatched",
  ]) {
    statuses.push((await fetch(`http://127.0.0.1:${port}${path}`)).status);
  }
  server.close();
  answer({ statuses });
} else if (mode === "fetch") {
  const http = await import("node:http");
  const received = await new Promise<Record<string, unknown>>((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(204).end();
      server.close();
      resolve(request.headers);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      void Sentry.startSpan({ name: "outgoing", forceTransaction: true }, () =>
        fetch(`http://127.0.0.1:${port}/`),
      );
    });
  });
  answer(received);
}
await Sentry.flush(5000);
process.exit(0);
