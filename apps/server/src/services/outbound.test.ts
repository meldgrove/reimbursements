// A lost database connection while an email is composed is an interruption
// for the worker (database.ts), not a definite failure of the email.
import pg from "pg";
import { describe, expect, it } from "vitest";
import * as outbound from "./outbound";

function lost(): pg.DatabaseError {
  const error = new pg.DatabaseError("terminating connection due to administrator command", 0, "error");
  error.code = "57P01";
  return error;
}

describe("composing an email", () => {
  it("hands a lost database connection on to the worker", async () => {
    const error = lost();
    await expect(
      outbound.send(
        async () => {
          throw error;
        },
        { id: "email-1" },
      ),
    ).rejects.toBe(error);
  });

  it("fails definitely on any other error", async () => {
    const result = await outbound.send(
      async () => {
        throw new Error("no snapshot");
      },
      { id: "email-1" },
    );
    expect([result.state, result.errorCode]).toEqual(["failed", "message_unavailable"]);
  });
});
