import {
  updaterStatusSchema,
  type UpdateChannel,
  type UpdaterStatus,
  type UpdatesResponse,
} from "@reimbursements/shared/api/updates";
import type { ServerErrorStatusCode } from "hono/utils/http-status";
import { config } from "../config";
import { logger } from "../logger";

/**
 * The calls of the Meldgrove Updater's API (`UPDATER_URL`) that admins make
 * through `/admin/updates`, and how long each may take. The updater has no
 * authentication; only the app reaches it, on the Compose network.
 */
export const UPDATER_CALLS = {
  status: { method: "GET", path: "/v1/status", timeoutMs: 3_000 },
  check: { method: "POST", path: "/v1/check", timeoutMs: 35_000 },
  install: { method: "POST", path: "/v1/install", timeoutMs: 10_000 },
  channel: { method: "POST", path: "/v1/channel", timeoutMs: 35_000 },
} as const;

export type UpdaterRequest =
  | { call: "status" }
  | { call: "check" }
  | { call: "install"; version: string }
  | { call: "channel"; channel: UpdateChannel };

/**
 * The app's answer: 200 (202 when an installation started), 409 when the
 * updater refused (4xx), or the updater's own 5xx (it may have started).
 */
export type UpdatesAnswer = { status: 200 | 202 | 409 | ServerErrorStatusCode; body: UpdatesResponse };

type Outcome =
  /** `status` is null only for a 202 whose body cannot be read: the updater took it all the same. */
  | { kind: "status"; accepted: boolean; status: UpdaterStatus | null }
  | { kind: "refused"; httpStatus: number; error: string }
  | { kind: "unreachable"; error: string; timedOut: boolean };

const MAX_ERROR_LENGTH = 1000;

async function send(base: string, request: UpdaterRequest): Promise<Outcome> {
  const { method, path, timeoutMs } = UPDATER_CALLS[request.call];
  const body =
    request.call === "install"
      ? { version: request.version }
      : request.call === "channel"
        ? { channel: request.channel }
        : undefined;
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
  } catch (error) {
    const timedOut = (error as { name?: unknown } | null)?.name === "TimeoutError";
    logger.debug({ call: request.call, timedOut }, "update service not reached");
    return {
      kind: "unreachable",
      timedOut,
      error: timedOut
        ? `The update service did not answer within ${timeoutMs / 1000} seconds.`
        : "The update service is not reachable.",
    };
  }
  if (!response.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    logger.warn({ call: request.call, status: response.status }, "update service refused");
    return {
      kind: "refused",
      httpStatus: response.status,
      error:
        typeof message === "string" && message.trim()
          ? message.trim().slice(0, MAX_ERROR_LENGTH)
          : `The update service refused (HTTP ${response.status}).`,
    };
  }
  const parsed = updaterStatusSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn({ call: request.call, status: response.status }, "update service sent an unknown answer");
    if (response.status === 202) return { kind: "status", accepted: true, status: null };
    // Something else answers at UPDATER_URL (a proxy page, another service):
    // no updater there, as in the Django version.
    if (typeof data !== "object" || data === null || Array.isArray(data) || !("mode" in data)) {
      return {
        kind: "unreachable",
        timedOut: false,
        error: "UPDATER_URL answers, but not as an update service.",
      };
    }
    return {
      kind: "refused",
      httpStatus: 409,
      error: "The update service sent an answer this version does not understand.",
    };
  }
  return { kind: "status", accepted: response.status === 202, status: parsed.data };
}

/**
 * Asks the updater and answers as every `/admin/updates` route does
 * (`UpdatesResponse`): a refusal is a 409 with `error` and the latest
 * status, an error of the updater keeps its 5xx (with the latest status),
 * an updater that does not answer is `reachable: false` (200). After a
 * change that took too long, the latest status shows whether it happened
 * anyway; a 202 whose body cannot be read stays a 202 with it.
 */
export async function askUpdater(request: UpdaterRequest): Promise<UpdatesAnswer> {
  const app = { version: config().APP_VERSION ?? null };
  const base = config().UPDATER_URL;
  if (!base) return { status: 200, body: { app, reachable: false, updater: null, error: null } };

  const outcome = await send(base, request);
  if (outcome.kind === "status" && outcome.status) {
    return {
      status: outcome.accepted ? 202 : 200,
      body: { app, reachable: true, updater: outcome.status, error: null },
    };
  }
  const followUp = request.call !== "status" && (outcome.kind !== "unreachable" || outcome.timedOut);
  if (outcome.kind === "unreachable" && !followUp) {
    return { status: 200, body: { app, reachable: false, updater: null, error: outcome.error } };
  }
  const latest = followUp ? await send(base, { call: "status" }) : null;
  const updater = latest?.kind === "status" ? latest.status : null;
  if (outcome.kind === "status") {
    return { status: 202, body: { app, reachable: true, updater, error: null } };
  }
  if (outcome.kind === "refused") {
    const status = outcome.httpStatus >= 500 ? (outcome.httpStatus as ServerErrorStatusCode) : 409;
    return { status, body: { app, reachable: true, updater, error: outcome.error } };
  }
  return { status: 200, body: { app, reachable: updater !== null, updater, error: outcome.error } };
}
