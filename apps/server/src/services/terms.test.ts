/** A form's terms: what a participant agrees to, and the revision drafts are opened against (tests/test_terms.py). */
import { describe, expect, it } from "vitest";
import type { PrivacyNotice } from "../db/schema";
import { Terms } from "./terms";

const notice = (version: number) => ({ version }) as PrivacyNotice;

type Fields = {
  declaration: string;
  declarationVersion: string;
  privacyNotice: PrivacyNotice | null;
  purposeOptions: readonly string[];
  travel: "off" | "optional" | "required";
  mileageRate: string | null;
};

const make = (fields: Fields) =>
  new Terms(
    fields.declaration,
    fields.declarationVersion,
    fields.privacyNotice,
    fields.purposeOptions,
    fields.travel,
    fields.mileageRate,
  );

const AGREED: Fields = {
  declaration: "Ich bestätige die Angaben.",
  declarationVersion: "2026-1",
  privacyNotice: notice(3),
  purposeOptions: ["Workshop", "Reise"],
  travel: "optional",
  mileageRate: "0.30",
};
// Another value for every field; a new field needs one too.
const CHANGED: Fields = {
  declaration: "Neue Erklärung.",
  declarationVersion: "2026-2",
  privacyNotice: notice(4),
  purposeOptions: ["Workshop"],
  travel: "required",
  mileageRate: "0.35",
};

describe("terms", () => {
  it("the revision stays the digest open drafts were opened with", () => {
    // Digests of earlier releases (the Django version): a changed digest sends every open draft back.
    expect(make(AGREED).revision).toBe("a4e9c99bcbacafbf");
    const noMileage = make({
      declaration: "I confirm.",
      declarationVersion: "1",
      privacyNotice: null,
      purposeOptions: [],
      travel: "off",
      mileageRate: null,
    });
    expect(noMileage.revision).toBe("10b14802a889d26f");
    // Quotes, control characters and non-ASCII text are written as Python's json.dumps writes them.
    const escaped = make({
      declaration: 'Ich bestätige "x"\n\tz',
      declarationVersion: "v1",
      privacyNotice: notice(3),
      purposeOptions: ["Workshop ä", "B"],
      travel: "optional",
      mileageRate: "0.30",
    });
    expect(escaped.revision).toBe("4dc276cb824d8790");
  });

  it.each(Object.keys(CHANGED) as Array<keyof Fields>)("every term is part of the revision: %s", (name) => {
    expect(make({ ...AGREED, [name]: CHANGED[name] }).revision).not.toBe(make(AGREED).revision);
  });

  it.each([
    ["privacyNotice", null],
    ["purposeOptions", []],
    ["mileageRate", null],
  ] as const)("a missing term changes the revision too: %s", (name, value) => {
    expect(make({ ...AGREED, [name]: value }).revision).not.toBe(make(AGREED).revision);
  });

  it("a single preset fixes the purpose", () => {
    expect(make({ ...AGREED, purposeOptions: ["Workshop"] }).fixedPurpose).toBe("Workshop");
    expect(make(AGREED).fixedPurpose).toBeNull();
    expect(make({ ...AGREED, purposeOptions: [] }).fixedPurpose).toBeNull();
  });

  it("the form page gets the terms it applies", () => {
    expect(make(AGREED).scriptConfiguration()).toEqual({
      travel: "optional",
      mileageRate: "0.30",
      purposeOptions: true,
      fixedPurpose: null,
    });
    expect(
      make({ ...AGREED, mileageRate: null, purposeOptions: ["Workshop"] }).scriptConfiguration(),
    ).toEqual({
      travel: "optional",
      mileageRate: null,
      purposeOptions: true,
      fixedPurpose: "Workshop",
    });
  });
});
