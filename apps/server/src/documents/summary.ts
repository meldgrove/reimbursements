/**
 * The first pages of the claim PDF: the participant's details, the
 * assignment, the expense table and the signed declaration. The layout of
 * 0.4's summary.html (WeasyPrint), built with pdfmake: A4, margins 15/15/18 mm,
 * DejaVu Sans 9 pt, the same colours and column widths.
 *
 * pdfmake reads nothing itself: the fonts come from the bundled files, the
 * signature from the manifest, and its URL and file access policies refuse
 * everything else.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as PdfmakeModule from "pdfmake";
import type {
  Content,
  ContentTable,
  CustomTableLayout,
  TDocumentDefinitions,
  TFontDictionary,
} from "pdfmake/interfaces";
import { SERVER_ROOT } from "../paths";
import type { ClaimSummary, SummaryRow } from "./manifest";

const MM = 72 / 25.4;
const PAGE_WIDTH = 595.28;
const MARGIN = { left: 15 * MM, top: 15 * MM, right: 15 * MM, bottom: 18 * MM };
/** The browser's default body margin (8 px), which 0.4's template kept inside the page margins. */
const BODY = 6;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN.left - MARGIN.right - 2 * BODY;
const BORDER = 0.3 * MM;
const COLORS = {
  text: "#172033",
  heading: "#134e4a",
  eyebrow: "#004632",
  meta: "#555555",
  rule: "#d9e1e8",
  box: "#f0f5f8",
};
/** CSS line-height 1.4 over DejaVu Sans' own line height (ascender and descender: 1.164 em). */
const LINE_HEIGHT = 1.4 / 1.164;
const FONT = "DejaVuSans";

/** The bundled fonts; the document child gets the folder from the parent (DOCUMENT_FONTS). */
export function fontsDirectory(): string {
  return process.env.DOCUMENT_FONTS || path.join(SERVER_ROOT, "assets", "fonts");
}

// pdfmake is a CommonJS module whose export is an instance; require() gets it in
// the sources and in the bundle alike.
type Pdfmake = typeof PdfmakeModule;
let instance: Pdfmake | undefined;

function pdfmake(): Pdfmake {
  if (instance) return instance;
  const loaded = createRequire(import.meta.url)("pdfmake") as Pdfmake;
  const directory = fontsDirectory();
  const regular = readFileSync(path.join(directory, "DejaVuSans.ttf"));
  const bold = readFileSync(path.join(directory, "DejaVuSans-Bold.ttf"));
  // Font buffers, not file names: pdfmake opens no file.
  loaded.setFonts({
    [FONT]: { normal: regular, bold, italics: regular, bolditalics: bold },
  } as unknown as TFontDictionary);
  loaded.setUrlAccessPolicy(() => false);
  loaded.setLocalAccessPolicy(() => false);
  instance = loaded;
  return loaded;
}

function heading(text: string): Content {
  return { text, bold: true, fontSize: 11, color: COLORS.heading, margin: [0, 4 * MM, 0, 1.5 * MM] };
}

function ruledLayout(
  padding: { x: number; y: number },
  lines: (index: number, rows: number) => boolean,
): CustomTableLayout {
  return {
    hLineWidth: (index, node) => (lines(index, node.table.body.length) ? BORDER : 0),
    vLineWidth: () => 0,
    hLineColor: () => COLORS.rule,
    paddingLeft: () => padding.x,
    paddingRight: () => padding.x,
    paddingTop: () => padding.y,
    paddingBottom: () => padding.y,
  };
}

/** A table of labels and values with a rule under every row (table.details). */
function details(rows: SummaryRow[]): ContentTable {
  return {
    table: {
      widths: ["34%", "*"],
      body: rows.map(([label, value]) => [{ text: label, color: COLORS.meta }, { text: value }]),
    },
    layout: ruledLayout({ x: 1.5 * MM, y: 1 * MM }, (index) => index > 0),
  };
}

/** The shaded assignment box (.box with its borderless details table). */
function box(rows: SummaryRow[]): ContentTable {
  return {
    margin: [0, 1.5 * MM, 0, 0],
    table: {
      widths: ["*"],
      body: [
        [
          {
            fillColor: COLORS.box,
            table: {
              widths: ["48%", "*"],
              body: rows.map(([label, value]) => [{ text: label, color: COLORS.meta }, { text: value }]),
            },
            layout: {
              hLineWidth: () => 0,
              vLineWidth: () => 0,
              paddingLeft: () => 0,
              paddingRight: () => 1.5 * MM,
              paddingTop: () => 0.5 * MM,
              paddingBottom: () => 0.5 * MM,
            },
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 3 * MM,
      paddingRight: () => 3 * MM,
      paddingTop: () => 3 * MM,
      paddingBottom: () => 3 * MM,
    },
  };
}

function expenseTable(summary: ClaimSummary): ContentTable {
  const { columns, rows, total } = summary.expenses;
  const head = columns.map((text, index) => ({
    text,
    bold: true,
    fontSize: 8,
    color: "#ffffff",
    fillColor: COLORS.heading,
    ...(index === 4 ? { alignment: "right" as const } : {}),
  }));
  const body = rows.map((row) => [
    { text: row.number },
    { text: row.partner.join("\n") },
    { text: row.purpose.join("\n") },
    { text: row.reference },
    { text: row.amount, alignment: "right" as const, noWrap: true },
  ]);
  const totalRow = [
    { text: "" },
    { text: total.label, colSpan: 3, bold: true },
    { text: "" },
    { text: "" },
    { text: total.amount, alignment: "right" as const, noWrap: true, bold: true },
  ];
  return {
    table: { headerRows: 1, widths: ["6%", "24%", "33%", "19%", "18%"], body: [head, ...body, totalRow] },
    // A rule under the header and every expense; none above the header or under the total.
    layout: ruledLayout({ x: 1.5 * MM, y: 2 * MM }, (index, count) => index > 0 && index < count),
  };
}

export function summaryDefinition(summary: ClaimSummary, signature: Buffer | null): TDocumentDefinitions {
  const meta = { fontSize: 8, color: COLORS.meta };
  const declaration = summary.declaration;
  return {
    pageSize: "A4",
    pageMargins: [MARGIN.left + BODY, MARGIN.top + BODY, MARGIN.right + BODY, MARGIN.bottom],
    defaultStyle: { font: FONT, fontSize: 9, color: COLORS.text, lineHeight: LINE_HEIGHT },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [MARGIN.left, (MARGIN.bottom - 9) / 2, MARGIN.right, 0],
      columns: [
        { text: summary.footer, fontSize: 7, color: "#666666", lineHeight: 1 },
        {
          text: `${currentPage} / ${pageCount}`,
          fontSize: 8,
          alignment: "right",
          width: "auto",
          lineHeight: 1,
        },
      ],
    }),
    images: signature ? { signature: `data:image/png;base64,${signature.toString("base64")}` } : {},
    content: [
      {
        text: summary.eyebrow.toLocaleUpperCase(summary.language),
        fontSize: 8,
        color: COLORS.eyebrow,
        characterSpacing: 1,
      },
      { text: summary.title, bold: true, fontSize: 18, color: COLORS.heading, lineHeight: 1.1 },
      { text: summary.meta.join("\n"), ...meta, margin: [0, 8, 0, 8] },
      {
        columnGap: 6 * MM,
        columns: [
          {
            width: CONTENT_WIDTH * 0.58,
            stack: [heading(summary.personal.heading), details(summary.personal.rows)],
          },
          { width: "*", stack: [heading(summary.assignment.heading), box(summary.assignment.rows)] },
        ],
      },
      heading(summary.occasion.heading),
      details(summary.occasion.rows),
      heading(summary.expenses.heading),
      expenseTable(summary),
      // Its bottom margin collapses into the next heading's, as in CSS.
      { text: summary.receiptNote, ...meta, margin: [0, 8, 0, 0] },
      {
        unbreakable: true,
        // Paragraph margins of 1.5 mm, which collapse between paragraphs as in CSS.
        stack: [
          heading(declaration.heading),
          { text: declaration.text, margin: [0, 0, 0, 1.5 * MM] },
          ...(signature ? [{ image: "signature", fit: [60 * MM, 16 * MM] as [number, number] }] : []),
          { text: declaration.signed, margin: [0, 1.5 * MM, 0, 0] },
          { text: declaration.versions, ...meta, margin: [0, 1.5 * MM, 0, 0] },
        ],
      },
    ],
    info: { title: summary.title, producer: summary.footer, creator: summary.footer },
  };
}

/** The summary pages as a PDF. */
export async function renderSummary(summary: ClaimSummary, signature: Buffer | null): Promise<Buffer> {
  const document = pdfmake().createPdf(summaryDefinition(summary, signature));
  return Buffer.from(await document.getBuffer());
}
