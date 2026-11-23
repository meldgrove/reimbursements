/** A privacy notice published while a claim is submitted (tests/test_drafts.py). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { claims, privacyNotices } from "../db/schema";
import { errorMessage, freshIntake, post, prepared } from "../test/intake";
import type * as Drafts from "./drafts";

const race = vi.hoisted(() => ({ active: false }));

// The gate passes; then a new privacy notice appears before acceptance reads the terms.
vi.mock("./drafts", async (importOriginal) => {
  const original = await importOriginal<typeof Drafts>();
  return {
    ...original,
    gate: async (...args: Parameters<typeof original.gate>) => {
      const result = await original.gate(...args);
      if (race.active)
        await getDb().insert(privacyNotices).values({ version: 2, text: "Neu veröffentlicht." });
      return result;
    },
  };
});

describe("a privacy notice published during submit", () => {
  beforeEach(async () => {
    await freshIntake();
  });

  it("sends the draft back", async () => {
    const current = await prepared();
    race.active = true;
    const response = await post(current);
    race.active = false;
    expect(response.status).toBe(409);
    expect(errorMessage(response)).toContain("aktualisiert");
    expect(await getDb().$count(claims)).toBe(0);
  });
});
