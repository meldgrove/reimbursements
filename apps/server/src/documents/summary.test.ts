import { describe, expect, it } from "vitest";
import { renderSummary } from "./summary";
import { pdfText, summaryFixture } from "./test-files";

const MM = 72 / 25.4;

/** An unbroken token of `length` characters that ends in `end`, so a clipped tail shows. */
function token(length: number, end: string): string {
  return "x".repeat(length - end.length) + end;
}

describe("summary", () => {
  // 0.4's cells wrapped anywhere (overflow-wrap: anywhere): every accepted value stays on the page.
  it("keeps long accepted values inside the margins and prints their ends", async () => {
    const values = {
      email: token(254, "MAILEND"),
      purpose: token(3000, "PURPOSEEND"),
      name: token(200, "NAMEEND"),
      holder: token(200, "HOLDEREND"),
      internal: token(200, "INTERNALEND"),
      form: token(200, "FORMEND"),
      partner: token(200, "PARTNEREND"),
      expense: token(200, "EXPENSEEND"),
      reference: token(100, "REFEND"),
      footer: token(200, "FOOTEREND"),
    };
    const summary = summaryFixture("Long values");
    summary.footer = `Meldgrove Reimbursement · ${values.footer}`;
    summary.personal.rows = [
      ["Name", values.name],
      ["Email", values.email],
      ["Account holder", values.holder],
    ];
    summary.assignment.rows = [
      ["Form", values.form],
      ["KST", values.internal],
    ];
    summary.occasion.rows = [["Occasion/project", values.purpose]];
    summary.expenses.rows = [
      {
        number: "1",
        partner: [values.partner],
        purpose: [values.expense],
        reference: values.reference,
        amount: "12,50 EUR",
      },
    ];
    const pages = await pdfText(await renderSummary(summary, null));
    const text = pages.map((page) => page.text.replace(/\s/g, "")).join("");
    for (const value of Object.values(values)) {
      expect(text).toContain(value.slice(-12));
    }
    for (const page of pages) {
      expect(page.left).toBeGreaterThanOrEqual(15 * MM - 0.5);
      expect(page.right).toBeLessThanOrEqual(page.width - 15 * MM + 0.5);
    }
  }, 60_000);
});
