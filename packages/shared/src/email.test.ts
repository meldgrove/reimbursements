import { describe, expect, it } from "vitest";
import { isEmail } from "./email";

describe("isEmail", () => {
  it.each([
    ["ada@example.invalid", true],
    ["ops@localhost", true],
    ["ılker@example.invalid", true],
    ["İlker@example.invalid", true],
    ["ada@[127.0.0.1]", true],
    ["ada@[::1]", true],
    ["ada@example", false],
    ["a..b@example.invalid", false],
    ["ädä@example.invalid", false],
    ["", false],
  ])("takes %s as Django's validate_email does (%s)", (value, valid) => {
    expect(isEmail(value)).toBe(valid);
  });
});
