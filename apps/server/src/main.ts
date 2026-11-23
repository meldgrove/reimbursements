import { serve } from "@hono/node-server";
import { config } from "./config";
import { logger } from "./logger";
import { closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { createApp } from "./http/app";
import { flushErrorReports } from "./error-reporting";
import { startWorker, type Stop } from "./worker";

/**
 * One entry point for every process. APP_ROLE selects what runs:
 *   all      web app and worker (default, simplest deployment)
 *   web      web app and API
 *   worker   jobs: upload checks, claim PDFs, email, retention (the Django version's run_jobs)
 *   migrate  apply database migrations (taking over a Django database), then exit
 */
async function main() {
  const settings = config();
  const role = settings.APP_ROLE;
  if (role === "migrate") {
    await runMigrations();
    await closeDb();
    return;
  }
  if (settings.RUN_MIGRATIONS) await runMigrations();
  if (settings.DEV_LOGIN) logger.warn("DEV_LOGIN is on: anyone can sign in as any user. Development only.");
  let server: ReturnType<typeof serve> | undefined;
  const stops: Stop[] = [];
  if (role === "all" || role === "web") {
    const app = createApp();
    server = serve({ fetch: app.fetch, port: settings.PORT, hostname: settings.HOST }, (info) => {
      logger.info({ port: info.port, url: settings.APP_URL }, "web app listening");
    });
  }
  if (role === "all" || role === "worker") stops.push(await startWorker());

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await Promise.allSettled([
      server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve(),
      ...stops.map((stopJob) => stopJob()),
    ]);
    await closeDb();
    await flushErrorReports();
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "startup failed");
  await flushErrorReports();
  process.exit(1);
});
