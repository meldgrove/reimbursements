import { pino, stdSerializers } from "pino";

type FailedQuery = Error & { query: string; params: unknown[] };

/**
 * Drizzle's DrizzleQueryError, recognized by its fields rather than its class,
 * which a second copy of drizzle-orm would not share.
 */
const isFailedQuery = (error: unknown): error is FailedQuery =>
  error instanceof Error &&
  typeof (error as Partial<FailedQuery>).query === "string" &&
  Array.isArray((error as Partial<FailedQuery>).params);

/**
 * A failed database query quotes its values, such as message texts, in its
 * message, stack and `params`. Its log entry keeps the query (placeholders
 * only), the database's error code and the code location.
 */
export function serializeError(error: unknown) {
  if (!isFailedQuery(error)) return stdSerializers.err(error as Error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  // The stack starts with the message; only the frames after it stay.
  const stack = error.stack ?? "";
  const start = stack.indexOf(error.message);
  return {
    type: error.constructor.name,
    query: error.query,
    code: typeof code === "string" ? code : undefined,
    stack: start === -1 ? undefined : stack.slice(start + error.message.length).replace(/^\n/, ""),
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
