/** The web app's Sentry start, with the settings the server puts in index.html. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startErrorReporting } from "./error-reporting";

afterEach(() => {
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("error reporting in the web app", () => {
  it("starts the SDK without its console warnings", async () => {
    const meta = document.createElement("meta");
    meta.name = "reimbursements-error-reporting";
    meta.content = JSON.stringify({
      dsn: "http://public@127.0.0.1:9/1",
      environment: "test",
      tracesSampleRate: 1,
    });
    document.head.append(meta);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startErrorReporting(() => "/f/$slug");
    const { getClient } = await import("@sentry/browser");
    expect(getClient()?.getOptions().dsn).toBe("http://public@127.0.0.1:9/1");
    const warnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.startsWith("[Sentry]"));
    expect(warnings).toEqual([]);
  });
});
