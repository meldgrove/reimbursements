import { pino } from "pino";

type FailedQuery = Error & { query: string; params: unknown[] };

/**
 * Drizzle's DrizzleQueryError, recognized by its fields rather than its class,
 * which a second copy of drizzle-orm would not share.
 */
const isFailedQuery = (error: unknown): error is FailedQuery =>
  error instanceof Error &&
  typeof (error as Partial<FailedQuery>).query === "string" &&
  Array.isArray((error as Partial<FailedQuery>).params);

/** The stack's frames without its first lines, which repeat the message. */
function frames(error: Error): string | undefined {
  const lines = (error.stack ?? "").split("\n");
  const first = lines.findIndex((line) => /^\s+at /.test(line));
  return first === -1 ? undefined : lines.slice(first).join("\n");
}

/**
 * Errors are logged without their values (portal/logging.py of the Django
 * version): a message can quote what failed, such as an IBAN, a receipt's
 * text, a file name or, for a failed database query, the query's values. The
 * entry keeps the error's type, its code (`code`, such as a processing
 * error's or the database's) and the code locations. The log line's own
 * message says what happened, with identifiers only.
 */
export function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  const own = (error as { code?: unknown }).code;
  const cause = (error.cause as { code?: unknown } | undefined)?.code;
  const code = typeof own === "string" ? own : typeof cause === "string" ? cause : undefined;
  return {
    type: error.name && error.name !== "Error" ? error.name : error.constructor.name,
    ...(isFailedQuery(error) ? { query: error.query } : {}),
    code,
    stack: frames(error),
  };
}

/**
 * Structured JSON logs. Never log message texts, answers, tokens or other
 * personal data; log identifiers instead.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { role: process.env.APP_ROLE?.trim() || "all" },
  serializers: { err: serializeError },
  redact: {
    paths: [
      "password",
      "token",
      "secret",
      "apiKey",
      "*.password",
      "*.token",
      "*.secret",
      "*.apiKey",
      "authorization",
      "cookie",
    ],
    censor: "[redacted]",
  },
  ...(process.env.NODE_ENV === "development" && process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } } }
    : {}),
});
