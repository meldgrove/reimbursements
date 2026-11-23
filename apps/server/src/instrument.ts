/*
 * Starts Sentry before anything else loads, so that requests, database
 * queries and outgoing calls can be traced. Production loads it first with
 * `node --import dist/instrument.mjs dist/main.mjs` (docker-entrypoint.sh),
 * development with `tsx --import`. It reads the environment directly: the
 * app's configuration loads later. Off unless SENTRY_DSN is set.
 */
import * as Sentry from "@sentry/node";
import {
  NO_DATA_COLLECTION,
  redactErrorReport,
  redactLog,
  scrubSpan,
  scrubText,
} from "@reimbursements/shared/error-reports";

const env = (name: string) => process.env[name]?.trim() || undefined;

/** The deployment, as config.ts decides it (DEPLOYMENT_ENV, DJANGO_DEBUG, NODE_ENV): the reports' environment. */
function deployment(): string {
  const named = env("DEPLOYMENT_ENV");
  if (named) return named;
  const debug = env("DJANGO_DEBUG");
  if (debug === "1") return "development";
  if (debug === "0") return "production";
  const node = env("NODE_ENV");
  return node === "development" || node === "test" ? "development" : "production";
}

function sampleRate(): number {
  const value = Number(env("SENTRY_TRACES_SAMPLE_RATE") ?? 0);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

const dsn = env("SENTRY_DSN");
if (dsn && !Sentry.isInitialized()) {
  const tracesSampleRate = sampleRate();
  const version = env("APP_VERSION");
  Sentry.init({
    dsn,
    environment: env("SENTRY_ENVIRONMENT") ?? deployment(),
    release: env("SENTRY_RELEASE") ?? (version ? `reimbursements@${version}` : undefined),
    defaultIntegrations: false,
    integrations: [
      // Errors logged at error or fatal become issues; warnings and up become logs.
      Sentry.pinoIntegration({
        error: { levels: ["error", "fatal"] },
        log: { levels: ["warn", "error", "fatal"] },
      }),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      Sentry.linkedErrorsIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.contextLinesIntegration(),
      ...(tracesSampleRate > 0
        ? [
            // Incoming requests only: calls to connected apps carry email
            // addresses in their paths and filters.
            Sentry.httpIntegration({ breadcrumbs: false, ignoreOutgoingRequests: () => true }),
            Sentry.honoIntegration(),
            Sentry.postgresIntegration(),
          ]
        : []),
    ],
    tracesSampleRate,
    dataCollection: NO_DATA_COLLECTION,
    maxBreadcrumbs: 0,
    // Page paths are made of page titles: traces keep route patterns only.
    beforeSendSpan: (span) => scrubSpan(span),
    beforeSendTransaction: (event) => ({
      ...event,
      transaction: event.transaction ? scrubText(event.transaction) : event.transaction,
    }),
    beforeSend: (event) => {
      const report = redactErrorReport(event);
      // Failed requests log their route pattern, e.g. `PUT /api/v1/pages/:id`.
      const route = report.contexts?.pino?.route;
      if (typeof route === "string") report.transaction = route;
      return report;
    },
    beforeSendLog: redactLog,
  });
  Sentry.getGlobalScope().setTag("role", env("APP_ROLE") ?? "all");
}
