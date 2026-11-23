/**
 * Document conversion: what the document child does after it is confined
 * (portal/file_worker.py in 0.4). Only file-worker.ts imports this module, and
 * only after lockdown(), so no parser loads before the sandbox is in place.
 *
 * - validate: checks a receipt or signature; images are normalized into the
 *   workspace (orientation applied, metadata dropped, alpha on white), a PDF
 *   is checked and stays its own output.
 * - build: the claim PDF from the summary and every receipt page, rasterized,
 *   in the largest quality that stays under the size cap.
 *
 * Errors with a code are DocumentError; anything else a library throws
 * leaves the child only as `invalid_document` (file-worker.ts), never with
 * its message, which may hold file names or document text.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFHexString,
  decodePDFRawStream,
} from "pdf-lib";
import sharp, { type Sharp, type SharpOptions } from "sharp";
import {
  APP_NAME,
  MAX_IMAGE_PIXELS,
  MAX_NORMALIZED_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_RECEIPT_DIMENSION,
} from "../constants";
import type { BuildManifest, BuildResult, ReceiptInput, UploadKind, ValidateResult } from "./manifest";
import { PdfiumDocument } from "./pdfium";
import { renderSummary } from "./summary";

export class DocumentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DocumentError";
  }
}

/** Bounds the tests lower, as they patched the module constants in 0.4. */
export const limits = {
  normalizedFileBytes: MAX_NORMALIZED_FILE_BYTES,
  receiptRasterBytes: 512_000_000,
};

const BLOCKED_PDF_KEYS = new Set([
  "JS",
  "JavaScript",
  "Launch",
  "EmbeddedFiles",
  "EmbeddedFile",
  "XFA",
  "SubmitForm",
  "ImportData",
  "RichMedia",
  "AA",
]);
const BLOCKED_ACTIONS = new Set(["JavaScript", "Launch", "GoToR", "GoToE"]);
const MAX_PDF_OBJECTS = 100_000;
const MAX_PAGE_POINTS = 14_400;
/** A4 in points, portrait. */
const A4 = { width: 595.28, height: 841.89 };
const PAGE_MARGIN = 18;
/** The quality passes of the assembly, best first. */
export const PASSES: ReadonlyArray<readonly [dpi: number, quality: number]> = [
  [160, 85],
  [140, 78],
  [120, 70],
  [100, 65],
  [90, 55],
  [72, 50],
];

sharp.cache(false);

/** Writes `content` to `target` durably and atomically, through `<target without extension>.tmp`. */
function writeDurably(target: string, content: Uint8Array) {
  const temporary = target.replace(/\.[^./]+$/, "") + ".tmp";
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
}

function startsWith(header: Uint8Array, prefix: number[] | string): boolean {
  const bytes = typeof prefix === "string" ? [...prefix].map((char) => char.charCodeAt(0)) : prefix;
  return bytes.every((byte, index) => header[index] === byte);
}

function readHeader(source: string): Uint8Array {
  const fd = openSync(source, "r");
  try {
    const header = new Uint8Array(12);
    const length = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/** Walks every object reachable from the trailer; active content or more than 100,000 objects fail. */
export function checkPdfObjects(document: PDFDocument) {
  const context = document.context;
  const trailer = context.trailerInfo;
  const pending: PDFObject[] = [trailer.Root, trailer.Info, trailer.Encrypt, trailer.ID].filter(
    (value): value is PDFObject => value !== undefined,
  );
  const seen = new Set<string>();
  while (pending.length > 0) {
    let object: PDFObject | undefined = pending.pop();
    if (object instanceof PDFRef) {
      const key = `${object.objectNumber} ${object.generationNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > MAX_PDF_OBJECTS) throw new DocumentError("pdf_complexity");
      object = context.lookup(object);
    }
    if (object instanceof PDFStream) object = object.dict;
    if (object instanceof PDFDict) {
      const entries = object.entries();
      for (const [key] of entries) {
        if (BLOCKED_PDF_KEYS.has(key.decodeText())) throw new DocumentError("pdf_active_content");
      }
      const action = object.get(PDFName.of("S"));
      if (action instanceof PDFName && BLOCKED_ACTIONS.has(action.decodeText())) {
        throw new DocumentError("pdf_active_content");
      }
      for (const [, value] of entries) pending.push(value);
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    }
  }
}

/** The image normalized: orientation applied, alpha on white, bounded size; metadata never survives. */
async function normalizedImage(source: string, signature: boolean): Promise<Sharp> {
  const options: SharpOptions = {
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: "warning",
    sequentialRead: true,
  };
  const metadata = await sharp(source, options).metadata();
  // MPO (camera JPEGs with auxiliary pictures) is a JPEG: sharp opens its primary picture.
  if (metadata.format !== "jpeg" && metadata.format !== "png") throw new DocumentError("unsupported_type");
  // Decoding all of it is the check Pillow's verify() was.
  await sharp(source, options).raw().toBuffer();
  const clean = sharp(source, options)
    .autoOrient()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .removeAlpha();
  if (signature) {
    const { data, info } = await clean.clone().raw().toBuffer({ resolveWithObject: true });
    if (!hasInk(data, info.channels)) throw new DocumentError("empty_signature");
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).resize(
      2400,
      1200,
      {
        fit: "inside",
        withoutEnlargement: true,
        kernel: "lanczos3",
      },
    );
  }
  // About 300 DPI on an A4 page; bound derived storage before JPEG encoding.
  return clean.resize(MAX_RECEIPT_DIMENSION, MAX_RECEIPT_DIMENSION, {
    fit: "inside",
    withoutEnlargement: true,
    kernel: "lanczos3",
  });
}

/**
 * Whether a pixel differs from white by more than 30 in luminance (ITU-R 601-2,
 * as Pillow's "L" conversion of the difference to white).
 */
function hasInk(data: Uint8Array, channels: number): boolean {
  for (let index = 0; index < data.length; index += channels) {
    const red = 255 - data[index]!;
    const green = 255 - data[index + 1]!;
    const blue = 255 - data[index + 2]!;
    if (Math.floor((red * 299 + green * 587 + blue * 114) / 1000) > 30) return true;
  }
  return false;
}

/** Checks `source` and, for an image, writes its normalized form into `destination`. */
export async function validateFile(
  source: string,
  destination: string,
  kind: UploadKind,
): Promise<ValidateResult> {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const header = readHeader(source);
  if (startsWith(header, "%PDF-")) {
    if (kind === "signature") throw new DocumentError("unsupported_type");
    const bytes = readFileSync(source);
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (document.isEncrypted) throw new DocumentError("encrypted_pdf");
    const count = document.getPageCount();
    if (count < 1 || count > MAX_PDF_PAGES) throw new DocumentError("pdf_pages");
    checkPdfObjects(document);
    const rendered = await PdfiumDocument.open(bytes);
    try {
      rendered.initForms();
      if (rendered.pageCount() !== count) throw new DocumentError("invalid_pdf");
      for (let index = 0; index < count; index += 1) {
        const { width, height } = rendered.pageSize(index);
        if (!(width >= 1 && width <= MAX_PAGE_POINTS && height >= 1 && height <= MAX_PAGE_POINTS)) {
          throw new DocumentError("pdf_dimensions");
        }
      }
    } finally {
      rendered.close();
    }
    // PDF pages are rasterized at assembly, preserving visible fields and annotations
    // while preventing active objects from entering the authoritative output.
    return { normalized: source, mediaType: "application/pdf", pages: count };
  }
  if (!startsWith(header, PNG) && !startsWith(header, JPEG)) throw new DocumentError("unsupported_type");
  const image = await normalizedImage(source, kind === "signature");
  const signature = kind === "signature";
  const content = signature
    ? await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : await image.jpeg({ quality: 94, optimiseCoding: true }).toBuffer();
  if (content.length > limits.normalizedFileBytes) throw new DocumentError("normalized_size_limit");
  const normalized = path.join(destination, signature ? "normalized.png" : "normalized.jpg");
  writeDurably(normalized, content);
  return { normalized, mediaType: signature ? "image/png" : "image/jpeg", pages: 1 };
}

/** Every receipt page as an image: PDFs rendered into JPEG files in the workspace, images as they are. */
export async function receiptImages(
  receipts: ReceiptInput[],
  workspace: string,
): Promise<Array<{ path: string; label: string }>> {
  const images: Array<{ path: string; label: string }> = [];
  let diskBytes = 0;
  for (const receipt of receipts) {
    if (receipt.mediaType !== "application/pdf") {
      images.push({ path: receipt.path, label: receipt.label });
      continue;
    }
    const document = await PdfiumDocument.open(readFileSync(receipt.path));
    try {
      document.initForms();
      const count = document.pageCount();
      for (let index = 0; index < count; index += 1) {
        const { width, height } = document.pageSize(index);
        const scale = Math.min(160 / 72, Math.sqrt(12_000_000 / (width * height)));
        const page = document.render(index, scale);
        const content = await sharp(page.rgba, {
          raw: { width: page.width, height: page.height, channels: 4 },
        })
          .removeAlpha()
          .jpeg({ quality: 95, optimiseCoding: true })
          .toBuffer();
        if (content.length > limits.receiptRasterBytes - diskBytes)
          throw new DocumentError("workspace_limit");
        const target = path.join(workspace, `receipt-${images.length}.jpg`);
        writeDurably(target, content);
        diskBytes += statSync(target).size;
        images.push({ path: target, label: receipt.label });
      }
    } finally {
      document.close();
    }
  }
  return images;
}

/** One receipt image on an A4 page (landscape for wide images), scaled into 18 pt margins and centred. */
async function addReceiptPage(writer: PDFDocument, source: string, dpi: number, quality: number) {
  const metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  // Receipt images are normalized (orientation applied) or rendered pages: no EXIF to follow.
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const landscape = width > height * 1.1;
  const page = landscape ? { width: A4.height, height: A4.width } : A4;
  const available = { width: page.width - 2 * PAGE_MARGIN, height: page.height - 2 * PAGE_MARGIN };
  const { data, info } = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .resize(Math.floor((available.width / 72) * dpi), Math.floor((available.height / 72) * dpi), {
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .jpeg({ quality, optimiseCoding: true })
    .toBuffer({ resolveWithObject: true });
  const image = await writer.embedJpg(data);
  // The image's size at `dpi`, scaled to fill the available area, as 0.4 placed it.
  const natural = { width: (info.width / dpi) * 72, height: (info.height / dpi) * 72 };
  const factor = Math.min(available.width / natural.width, available.height / natural.height);
  const drawn = { width: natural.width * factor, height: natural.height * factor };
  writer.addPage([page.width, page.height]).drawImage(image, {
    x: (page.width - drawn.width) / 2,
    y: (page.height - drawn.height) / 2,
    ...drawn,
  });
}

/** Bookmarks: one per item, at its first page (pypdf's add_outline_item with /Fit). */
function addOutline(writer: PDFDocument, entries: Array<{ title: string; page: number }>) {
  if (entries.length === 0) return;
  const context = writer.context;
  const pages = writer.getPages();
  const outlinesRef = context.nextRef();
  const refs = entries.map(() => context.nextRef());
  entries.forEach((entry, index) => {
    const item = context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      Dest: [pages[entry.page]!.ref, PDFName.of("Fit")],
    });
    if (index > 0) item.set(PDFName.of("Prev"), refs[index - 1]!);
    if (index < refs.length - 1) item.set(PDFName.of("Next"), refs[index + 1]!);
    context.assign(refs[index]!, item);
  });
  context.assign(
    outlinesRef,
    context.obj({
      Type: "Outlines",
      First: refs[0]!,
      Last: refs[refs.length - 1]!,
      Count: PDFNumber.of(refs.length),
    }),
  );
  writer.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

function contentBytes(page: ReturnType<PDFDocument["getPage"]>): Uint8Array {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const parts: Uint8Array[] = [];
  for (const entry of streams) {
    const stream = entry instanceof PDFRef ? page.doc.context.lookup(entry) : entry;
    if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode());
    else if (stream instanceof PDFStream) parts.push(stream.getContents());
  }
  return Buffer.concat(parts);
}

function isBlank(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).toString("latin1").trim().length === 0;
}

/** Builds the claim PDF described by `manifestPath` into `output`. */
export async function buildPdf(manifestPath: string, output: string): Promise<BuildResult> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
  const workspace = path.dirname(output);
  const signature = manifest.signature ? readFileSync(manifest.signature) : null;
  const summaryBytes = await renderSummary(manifest.summary, signature);
  const summary = await PDFDocument.load(summaryBytes, { updateMetadata: false });
  const images = await receiptImages(manifest.receipts, workspace);
  const expected = summary.getPageCount() + images.length;
  // Every pass contains the same summary and every receipt page. The cap applies
  // to actual serialized output, never a guessed compression ratio.
  for (const [dpi, quality] of PASSES) {
    const writer = await PDFDocument.create({ updateMetadata: false });
    for (const page of await writer.copyPages(summary, summary.getPageIndices())) writer.addPage(page);
    const outline: Array<{ title: string; page: number }> = [];
    let previousLabel: string | undefined;
    for (const image of images) {
      const pageStart = writer.getPageCount();
      await addReceiptPage(writer, image.path, dpi, quality);
      if (image.label !== previousLabel) {
        outline.push({ title: image.label, page: pageStart });
        previousLabel = image.label;
      }
    }
    addOutline(writer, outline);
    writer.setTitle(manifest.title);
    writer.setProducer(APP_NAME);
    const content = await writer.save({ useObjectStreams: true });
    if (content.length > manifest.maxBytes) continue;
    const verification = await PDFDocument.load(content, { updateMetadata: false });
    if (verification.getPageCount() !== expected) throw new DocumentError("output_page_count");
    for (const page of verification.getPages()) {
      if (isBlank(contentBytes(page))) throw new DocumentError("output_blank_page");
    }
    writeDurably(output, content);
    return {
      size: content.length,
      checksum: createHash("sha256").update(content).digest("hex"),
      pages: expected,
      dpi,
      quality,
    };
  }
  // Some pathological inputs cannot meet an arbitrary cap legibly. Never omit
  // pages or send an oversized/partial attachment in order to claim success.
  rmSync(output, { force: true });
  throw new DocumentError("output_size_limit");
}
