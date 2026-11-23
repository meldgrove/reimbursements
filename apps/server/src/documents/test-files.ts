/**
 * Real files for the document tests, generated as the Django tests did with
 * Pillow and pypdf: receipts, signatures, camera pictures, PDFs with active
 * content, forms, encryption and many pages. Tests only.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  PDFDocument,
  PDFName,
  PDFString,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
import sharp from "sharp";
import type { BuildManifest, ClaimSummary, ReceiptInput } from "./manifest";

/** A deterministic byte stream (xorshift32), for noise that compresses badly. */
export function seededBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** A synthetic receipt (dark bars where 0.4 drew text) or a signature stroke, as PNG. */
export async function imageBytes(
  options: { signature?: boolean; color?: string; size?: [number, number] } = {},
): Promise<Buffer> {
  const [width, height] = options.signature ? [800, 240] : (options.size ?? [900, 1200]);
  const drawing = options.signature
    ? `<polyline points="80,160 150,60 210,170 300,80 440,150 600,100" stroke="#134e4a" stroke-width="5" fill="none"/>`
    : `<rect x="50" y="60" width="300" height="12" fill="black"/><rect x="50" y="110" width="160" height="12" fill="black"/>`;
  return sharp({ create: { width, height, channels: 3, background: options.color ?? "white" } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}">${drawing}</svg>`) }])
    .png()
    .toBuffer();
}

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A camera JPEG: EXIF orientation 6 and private metadata on a primary picture,
 * with an MPF header (APP2) and a separate auxiliary picture after it (MPO).
 */
export async function cameraJpegBytes(options: { primaryColor?: string } = {}): Promise<Buffer> {
  const primary = await sharp({
    create: { width: 320, height: 180, channels: 3, background: options.primaryColor ?? "forestgreen" },
  })
    .withExif({ IFD0: { ImageDescription: "Synthetic private camera metadata" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const auxiliary = await sharp({ create: { width: 80, height: 60, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  // MP Index IFD: version, number of images, MP entries (16 bytes each).
  const mpfLength = 4 + 8 + 2 + 3 * 12 + 4 + 32;
  const app2Length = mpfLength + 4;
  const primaryLength = primary.length + app2Length;
  const tiffStart = 2 + 4 + 4; // After SOI, the APP2 marker and length, "MPF\0".
  const tiff = Buffer.alloc(mpfLength - 4);
  tiff.write("II*\0", 0, "latin1");
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(3, 8);
  const entry = (index: number, tag: number, type: number, count: number, value: Buffer) => {
    const offset = 10 + index * 12;
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    value.copy(tiff, offset + 8);
  };
  const long = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const entriesOffset = 10 + 3 * 12 + 4;
  entry(0, 0xb000, 7, 4, Buffer.from("0100", "latin1"));
  entry(1, 0xb001, 4, 1, long(2));
  entry(2, 0xb002, 7, 32, long(entriesOffset));
  tiff.writeUInt32LE(0x20030000, entriesOffset); // Primary picture, baseline MP.
  tiff.writeUInt32LE(primaryLength, entriesOffset + 4);
  tiff.writeUInt32LE(0, entriesOffset + 8);
  tiff.writeUInt32LE(0x00020000, entriesOffset + 16); // A dependent picture.
  tiff.writeUInt32LE(auxiliary.length, entriesOffset + 20);
  tiff.writeUInt32LE(primaryLength - tiffStart, entriesOffset + 24);
  const app2 = segment(0xffe2, Buffer.concat([Buffer.from("MPF\0", "latin1"), tiff]));
  return Buffer.concat([primary.subarray(0, 2), app2, primary.subarray(2), auxiliary]);
}

/** A PDF of blank pages. */
export async function blankPdf(pages = 1, size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage(size);
  return document.save();
}

/** A PDF whose catalog carries `entries` (active content and the like). */
export async function pdfWith(
  add: (document: PDFDocument) => void | Promise<void>,
  options: { pages?: number } = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < (options.pages ?? 1); index += 1) document.addPage([595, 842]);
  await add(document);
  return document.save({ useObjectStreams: false });
}

/** JavaScript in the document's name tree, as pypdf's add_js wrote it. */
export function addJavaScript(document: PDFDocument) {
  const context = document.context;
  const action = context.register(
    context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('test')") }),
  );
  const tree = context.obj({ Names: [PDFString.of("test"), action] });
  document.catalog.set(PDFName.of("Names"), context.obj({ JavaScript: context.register(tree) }));
}

/** A launch action that opens when the document opens. */
export function addLaunchAction(document: PDFDocument) {
  const context = document.context;
  document.catalog.set(PDFName.of("OpenAction"), context.obj({ S: "Launch", F: PDFString.of("calc.exe") }));
}

/** An embedded file. */
export async function addEmbeddedFile(document: PDFDocument) {
  await document.attach(Buffer.from("synthetic attachment"), "note.txt", { mimeType: "text/plain" });
}

/** A PDF whose trailer names an encryption dictionary (the standard RC4 handler, empty user password). */
export function encryptedPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -4 >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A filled text field whose appearance is a black box, as commonly supplied on receipts. */
export async function filledFormPdf(): Promise<Uint8Array> {
  return pdfWith((document) => {
    const context = document.context;
    const page = document.getPage(0);
    const appearance = context.register(
      context.stream("q 0 0 0 rg 0 0 180 45 re f Q", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 180, 45],
      }),
    );
    const field = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Tx",
        T: PDFString.of("amount"),
        V: PDFString.of("12.50"),
        Rect: [80, 600, 260, 645],
        AP: { N: appearance },
        P: page.ref,
      }),
    );
    page.node.set(PDFName.of("Annots"), context.obj([field]));
    document.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [field] }));
  });
}

/** One page per colour, each filled with it (0.4 drew coloured images). */
export async function colouredPdf(colours: Array<[number, number, number]>): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (const [red, green, blue] of colours) {
    const page = document.addPage([480, 672]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 480,
      height: 672,
      color: rgb(red / 255, green / 255, blue / 255),
    });
  }
  return document.save();
}

/**
 * Pages of 1-bit noise images, 3000 x 4000 pixels at 160 dpi, one seed per
 * page: small as PDFs, large once rasterized.
 */
export async function noisePdf(seeds: number[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const [width, height] = [3000, 4000];
  for (const seed of seeds) {
    const image = document.context.register(
      document.context.flateStream(seededBytes(seed, (width / 8) * height), {
        Type: "XObject",
        Subtype: "Image",
        Width: width,
        Height: height,
        ColorSpace: "DeviceGray",
        BitsPerComponent: 1,
      }),
    );
    const [pageWidth, pageHeight] = [(width / 160) * 72, (height / 160) * 72];
    const page = document.addPage([pageWidth, pageHeight]);
    const name = page.node.newXObject("Im", image);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(pageWidth, 0, 0, pageHeight, 0, 0),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return document.save();
}

/** A short summary for assembly tests (0.4's tests used a one-line HTML page). */
export function summaryFixture(title = "Summary"): ClaimSummary {
  return {
    language: "en",
    footer: "Meldgrove Reimbursement · TEST",
    eyebrow: "Reimbursement of privately paid costs",
    title,
    meta: ["Reference TEST"],
    personal: { heading: "Personal details", rows: [["Name", "Alex Example"]] },
    assignment: { heading: "Assignment", rows: [["Form", "Test"]] },
    occasion: { heading: "Occasion", rows: [["Occasion/project", "Test"]] },
    expenses: {
      heading: "Expense items",
      columns: ["No.", "Business partner / journey", "Occasion/purpose", "Reference", "Amount"],
      rows: [],
      total: { label: "Total", amount: "0.00 EUR" },
    },
    receiptNote: "The receipts follow.",
    declaration: {
      heading: "Declaration and signature",
      text: "Synthetic declaration.",
      signatureLabel: "Signature",
      signed: "Alex Example · 2026-10-20",
      versions: "Declaration test confirmed.",
    },
  };
}

/** Writes a build manifest into `directory` and returns its path. */
export function writeManifest(
  directory: string,
  values: {
    receipts: ReceiptInput[];
    maxBytes: number;
    title?: string;
    summary?: ClaimSummary;
    signature?: string | null;
  },
): string {
  const manifest: BuildManifest = {
    summary: values.summary ?? summaryFixture(),
    signature: values.signature ?? null,
    receipts: values.receipts,
    title: values.title ?? "synthetic",
    maxBytes: values.maxBytes,
  };
  const file = path.join(directory, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

/**
 * The text of every page of a PDF and the rightmost edge of its characters, read
 * with PDFium (as the Django tests read text with pypdf and boxes with pypdfium2).
 */
export async function pdfText(
  bytes: Uint8Array,
): Promise<Array<{ text: string; width: number; left: number; right: number }>> {
  const { pdfium } = await import("./pdfium");
  const module = await pdfium();
  const memory = module.pdfium.wasmExports.malloc(bytes.byteLength);
  const heap = () => (module.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  heap().set(bytes, memory);
  const document = module.FPDF_LoadMemDocument(memory, bytes.byteLength, "");
  const pages: Array<{ text: string; width: number; left: number; right: number }> = [];
  const box = module.pdfium.wasmExports.malloc(32);
  try {
    for (let index = 0; index < module.FPDF_GetPageCount(document); index += 1) {
      const page = module.FPDF_LoadPage(document, index);
      const text = module.FPDFText_LoadPage(page);
      const count = module.FPDFText_CountChars(text);
      const buffer = module.pdfium.wasmExports.malloc((count + 1) * 2);
      module.FPDFText_GetText(text, 0, count, buffer);
      const content = Buffer.from(heap().subarray(buffer, buffer + count * 2)).toString("utf16le");
      module.pdfium.wasmExports.free(buffer);
      let left = Infinity;
      let right = 0;
      for (let char = 0; char < count; char += 1) {
        if (module.FPDFText_GetCharBox(text, char, box, box + 8, box + 16, box + 24)) {
          const [charLeft, charRight] = new Float64Array(heap().slice(box, box + 16).buffer);
          left = Math.min(left, charLeft!);
          right = Math.max(right, charRight!);
        }
      }
      pages.push({ text: content, width: module.FPDF_GetPageWidthF(page), left, right });
      module.FPDFText_ClosePage(text);
      module.FPDF_ClosePage(page);
    }
  } finally {
    module.pdfium.wasmExports.free(box);
    module.FPDF_CloseDocument(document);
    module.pdfium.wasmExports.free(memory);
  }
  return pages;
}
