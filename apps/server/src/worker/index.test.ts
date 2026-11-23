// The worker's loop stops before the next job when a stop arrives during maintenance.
import { expect, it, vi } from "vitest";

let stopping = false;
const runOne = vi.fn(async () => false);

vi.mock("../services/jobs", () => ({ reclaimStaleJobs: vi.fn(async () => 0), runOne }));
vi.mock("../services/evidence", () => ({
  // The stop signal arrives while maintenance runs.
  reconcileUnmatched: vi.fn(async () => {
    stopping = true;
  }),
}));
vi.mock("../services/retention", () => ({
  cleanup: vi.fn(async () => ({ failures: 0, unresolved_near_expiry: 0 })),
}));
vi.mock("../services/storage", () => ({ writeHeartbeat: vi.fn() }));

it("starts no job after a stop that arrived during maintenance", async () => {
  const { runJobs } = await import("./index");
  await runJobs({}, () => stopping);
  expect(runOne).not.toHaveBeenCalled();
});
