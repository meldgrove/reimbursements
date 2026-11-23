import * as Sentry from "@sentry/node";
import type { Hono, MiddlewareHandler } from "hono";
import { config, type Config } from "./config";
import type { AppEnv } from "./http/env";

/*
 * Sentry starts in instrument.ts, before the app loads. This module holds
 * what the running app needs: flushing, the web app's settings, tracing of
 * requests, and check-ins of the scheduled jobs.
 */

/** The release in reports: SENTRY_RELEASE, else `reimbursements@<APP_VERSION>` for release images. */
export function errorReportRelease(settings: Pick<Config, "SENTRY_RELEASE" | "APP_VERSION">) {
  return (
    settings.SENTRY_RELEASE ?? (settings.APP_VERSION ? `reimbursements@${settings.APP_VERSION}` : undefined)
  );
}

/** Sends pending reports; call it before the process exits. */
export const flushErrorReports = () => Sentry.flush(2000);

/** Where browsers send web app reports, for the Content-Security-Policy. */
export function errorReportingSources(): string[] {
  const dsn = config().SENTRY_DSN;
  return dsn ? [new URL(dsn).origin] : [];
}

/** Traces requests through Hono's routes when tracing is on. */
export function tracingMiddleware(app: Hono<AppEnv>): MiddlewareHandler | undefined {
  if (!Sentry.isInitialized() || config().SENTRY_TRACES_SAMPLE_RATE <= 0) return undefined;
  return Sentry.honoMiddleware(app);
}

/**
 * Runs a scheduled job with Sentry cron check-ins, so a job that stops
 * running or keeps failing raises an alert. Without Sentry it just runs.
 */
export function monitored<T>(slug: string, schedule: { minutes: number }, job: () => Promise<T>): Promise<T> {
  if (!Sentry.isInitialized()) return job();
  return Sentry.withMonitor(slug, job, {
    schedule: { type: "interval", value: schedule.minutes, unit: "minute" },
    checkinMargin: Math.max(5, Math.round(schedule.minutes / 4)),
    maxRuntime: 30,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
  });
}

/** The DSN without a secret key (old DSNs had one): it goes into every page. */
function publicDsn(dsn: string): string {
  const url = new URL(dsn);
  url.password = "";
  return url.toString();
}

const ATTRIBUTE_ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" };

/** Adds the web app's Sentry settings to index.html; the web app reports only with them. */
export function withErrorReportingSettings(indexHtml: string): string {
  const settings = config();
  if (!settings.SENTRY_DSN) return indexHtml;
  const content = JSON.stringify({
    dsn: publicDsn(settings.SENTRY_DSN),
    environment: settings.SENTRY_ENVIRONMENT ?? settings.DEPLOYMENT_ENV,
    release: errorReportRelease(settings),
    tracesSampleRate: settings.SENTRY_TRACES_SAMPLE_RATE,
  }).replace(/[&"<>]/g, (character) => ATTRIBUTE_ESCAPES[character]!);
  return indexHtml.replace(
    "</head>",
    `<meta name="reimbursements-error-reporting" content="${content}" />\n</head>`,
  );
}

/** Reports an unexpected error to Sentry, when it is on. */
export function reportError(error: unknown): void {
  if (Sentry.isInitialized()) Sentry.captureException(error);
}
