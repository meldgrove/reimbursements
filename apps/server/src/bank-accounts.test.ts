/** IBAN and BIC checks as python-stdnum made them. */
import { describe, expect, it } from "vitest";
import { isValidBic, isValidIban } from "./bank-accounts";

describe("bank accounts", () => {
  it.each([
    "DE89370400440532013000",
    "DE89 3704 0044 0532 0130 00",
    "CH9300762011623852957",
    "BR1800360305000010009795493C1",
    "AE070331234567890123456",
    "GB29NWBK60161331926819",
    "ES9121000418450200051332",
    "NO9386011117947",
    "ME25505000012345678951",
  ])("accepts %s", (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it.each([
    "DE89370400440532013001",
    "DE8937040044053201300",
    "XX89370400440532013000",
    "BE68539007547035",
    "ES9121000418450200051331",
    "NO9386011117948",
    "",
  ])("refuses %s", (iban) => {
    expect(isValidIban(iban)).toBe(false);
  });

  it("checks Belgian check digits, without stdnum's directory of Belgian banks", () => {
    // stdnum also refused Belgian IBANs of banks missing from its directory.
    expect(isValidIban("BE68539007547034")).toBe(true);
    expect(isValidIban("BE68539007547035")).toBe(false);
  });

  it("checks a BIC's form and country", () => {
    expect(isValidBic("BOFAUS3N")).toBe(true);
    expect(isValidBic("DEUTDEFF500")).toBe(true);
    expect(isValidBic("BOFA US 3N")).toBe(true);
    expect(isValidBic("NOTABIC")).toBe(false);
    expect(isValidBic("BOFAQQ3N")).toBe(false);
    expect(isValidBic("BOFAUS3N1")).toBe(false);
  });
});
