import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { getDb } from "../db/client";
import { draftAdmissions } from "../db/schema";
import { resetDatabase } from "../test/helpers";
import { budgetKey, chargeDraft } from "./network-budget";

beforeEach(async () => {
  await resetDatabase();
});

describe("network budgets across the upgrade", () => {
  it("are keyed as the Django version keyed them", () => {
    // salted_hmac("draft-admission", network, secret=<the tests' AUTH_SECRET>).hexdigest() in Django 5.2.
    expect(budgetKey("203.0.113.7/32")).toBe("48480a3c418d6d3172e91c561a86efc6c45fa24d");
    expect(budgetKey("2001:db8:1234::/48")).toBe("5fd8a3c123a3ae5de8251fc7cd35a60296d3a683");
  });

  it("keep counting what a network spent on 0.4", async () => {
    await getDb()
      .insert(draftAdmissions)
      .values({ key: "48480a3c418d6d3172e91c561a86efc6c45fa24d", count: config().MAX_DRAFTS_PER_NETWORK });
    expect(await chargeDraft("203.0.113.7/32")).toBe(false);
    expect(await chargeDraft("203.0.113.8/32")).toBe(true);
  });
});
