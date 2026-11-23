import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UpdaterStatus } from "@reimbursements/shared/api/updates";

/** A status as the Meldgrove Updater reports it: 0.2.0 runs, 0.2.1 is available. */
export function updaterStatus(overrides: Partial<UpdaterStatus> = {}): UpdaterStatus {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: {
      version: "0.2.1",
      preview: false,
      publishedAt: "2026-11-17T10:00:00.000Z",
      url: "https://github.com/meldgrove/reimbursements/releases/tag/v0.2.1",
      notes: ["Show who changed a page last"],
      changes: 1,
      installsAt: "2026-11-20T02:00:00.000Z",
      failed: null,
    },
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: "2026-11-19T08:00:00.000Z",
    error: null,
    automatic: true,
    cooldown: "3d",
    window: null,
    timezone: "UTC",
    ...overrides,
  };
}

type Reply = { status?: number; body?: unknown; delayMs?: number };
export type UpdaterCallRecord = { method: string; path: string; body: unknown };

/**
 * An updater API on a free local port for tests. Each request gets the reply
 * of `respond` (default: 200 with `updaterStatus()`); `calls` records them.
 */
export async function startFakeUpdater() {
  const calls: UpdaterCallRecord[] = [];
  let respond: (call: UpdaterCallRecord) => Reply = () => ({ body: updaterStatus() });
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const call = {
      method: request.method ?? "",
      path: request.url ?? "",
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    const reply = respond(call);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (response.destroyed) return;
    response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    response.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    respond(handler: (call: UpdaterCallRecord) => Reply) {
      respond = handler;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
