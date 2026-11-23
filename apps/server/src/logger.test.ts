import { afterEach, describe, expect, it } from "vitest";
import { serializeError } from "./logger";
import { OperatorError } from "./operator-error";
import { config, resetConfigForTests } from "./config";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  resetConfigForTests();
});

describe("errors in the log", () => {
  it("keep the operator's diagnostics, and no other error's message", () => {
    const refused = serializeError(
      new OperatorError("The database is from Reimbursements 0.2 or older. Install 0.4 first"),
    );
    expect(refused).toMatchObject({
      type: "OperatorError",
      message: expect.stringContaining("Install 0.4 first"),
    });
    const other = serializeError(new Error("invalid input syntax: DE89370400440532013000"));
    expect(other).not.toHaveProperty("message");
    expect(JSON.stringify(other)).not.toContain("DE89");
  });

  it("show what is wrong with the configuration", () => {
    process.env = {
      PATH: process.env.PATH ?? "",
      DEPLOYMENT_ENV: "production",
      PRIVATE_STORAGE_ROOT: "/tmp/private",
    };
    resetConfigForTests();
    let thrown: unknown;
    try {
      config();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperatorError);
    expect((serializeError(thrown) as { message?: string }).message).toContain(
      "Missing production configuration",
    );
  });
});
