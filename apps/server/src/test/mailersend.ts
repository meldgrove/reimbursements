import { vi } from "vitest";
import { provider } from "../services/mailersend";

/**
 * Plays MailerSend for a test: every API call goes to `handler` (the Django
 * tests' httpx.MockTransport). Throw from the handler for a connection
 * failure: `refused()` before transmission, `timedOut()` after it.
 * Undone by vi.restoreAllMocks().
 */
export function mockProvider(handler: (request: Request) => Response | Promise<Response>) {
  vi.spyOn(provider, "fetch").mockImplementation(async (url, init) => handler(new Request(url, init)));
}

/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A connection the provider refused: nothing was transmitted (httpx.ConnectError). */
export function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

/** A response that never came after the request left (httpx.ReadTimeout). */
export function timedOut(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}
