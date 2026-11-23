import { describe, expect, it } from "vitest";
import { option } from "./registry";

describe("option", () => {
  it.each([
    [["--to", "finance@example.invalid"], "finance@example.invalid"],
    [["--to=finance@example.invalid"], "finance@example.invalid"],
    [["--batch-size=3"], undefined],
    [["--to="], ""],
    [["--total", "x"], undefined],
    [["--to"], undefined],
    [[], undefined],
  ])("reads --to from %j as %j", (args, expected) => {
    expect(option(args, "--to")).toBe(expected);
  });

  it("reads --batch-size=3 as 3, not the default", () => {
    expect(option(["--batch-size=3"], "--batch-size")).toBe("3");
    expect(option(["--batch-size", "3"], "--batch-size")).toBe("3");
  });
});
