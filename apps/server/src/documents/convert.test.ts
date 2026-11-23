// The document child's work, run in this process as 0.4's tests called
// file_worker directly (tests/test_documents.py, tests/test_pdf_integrity.py,
// tests/test_resource_limits.py).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFHexString,
  type PDFRef,
} from "pdf-lib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf, checkPdfObjects, DocumentError, limits, receiptImages, validateFile } from "./convert";
import { PdfiumDocument } from "./pdfium";
import {
  addEmbeddedFile,
  addJavaScript,
  addLaunchAction,
  blankPdf,
  cameraJpegBytes,
  colouredPdf,
  encryptedPdf,
  filledFormPdf,
  imageBytes,
  pdfWith,
  seededBytes,
  writeManifest,
} from "./test-files";

let directory: string;
const original = { ...limits };

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "documents-"));
});

afterEach(() => {
  Object.assign(limits, original);
  rmSync(directory, { recursive: true, force: true });
});

function file(name: string, content: Uint8Array): string {
  const target = path.join(directory, name);
  writeFileSync(target, content);
  return target;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof DocumentError && error.code === code);
}

async function render(pdf: string, page: number, scale: number) {
  const document = await PdfiumDocument.open(readFileSync(pdf));
  try {
    const count = document.pageCount();
    const rendered = document.render(page, scale);
    return { count, ...rendered };
  } finally {
    document.close();
  }
}

function pixel(image: { width: number; rgba: Uint8Array }, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.rgba[offset]!, image.rgba[offset + 1]!, image.rgba[offset + 2]!];
}

describe("validate", () => {
  it("normalizes a real image and removes its metadata", async () => {
    const source = file("receipt.png", await imageBytes());
    const result = await validateFile(source, path.join(directory, "clean"), "receipt");
    expect(result.pages).toBe(1);
    expect(result.mediaType).toBe("image/jpeg");
    const metadata = await sharp(result.normalized).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.channels).toBe(3);
    expect(metadata.exif).toBeUndefined();
  });

  it("applies a camera picture's orientation and drops its private metadata", async () => {
    const source = file("camera.jpg", await cameraJpegBytes());
    const result = await validateFile(source, path.join(directory, "clean"), "receipt");
    const metadata = await sharp(result.normalized).metadata();
    expect([metadata.width, metadata.height]).toEqual([180, 320]);
    expect(metadata.exif).toBeUndefined();
    expect(readFileSync(result.normalized).includes("Synthetic private camera metadata")).toBe(false);
  });

  it("refuses a blank signature and documents that are not what they claim", async () => {
    const blank = await sharp({
      create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    await expectCode(
      validateFile(file("signature.png", blank), path.join(directory, "clean"), "signature"),
      "empty_signature",
    );
    const svg = file("receipt.png", Buffer.from("<svg>not an image</svg>"));
    await expectCode(validateFile(svg, path.join(directory, "clean"), "receipt"), "unsupported_type");
  });

  it("does not let ink from a camera's auxiliary picture count for a blank signature", async () => {
    const source = file("signature.jpg", await cameraJpegBytes({ primaryColor: "white" }));
    await expectCode(validateFile(source, path.join(directory, "clean"), "signature"), "empty_signature");
  });

  it("counts ink at the threshold as Pillow rounds it", async () => {
    // A stroke 31/31/30 below white: Pillow's luminance is 31, above the threshold of 30.
    const faint = await sharp({
      create: { width: 300, height: 100, channels: 3, background: "#ffffff" },
    })
      .composite([
        {
          input: { create: { width: 100, height: 4, channels: 3, background: { r: 224, g: 224, b: 225 } } },
          left: 100,
          top: 48,
        },
      ])
      .png()
      .toBuffer();
    const result = await validateFile(
      file("signature.png", faint),
      path.join(directory, "clean"),
      "signature",
    );
    expect(result).toMatchObject({ mediaType: "image/png" });
  });

  it("accepts a drawn signature as PNG", async () => {
    const source = file("signature.png", await imageBytes({ signature: true }));
    const result = await validateFile(source, path.join(directory, "clean"), "signature");
    expect(result).toMatchObject({ mediaType: "image/png", pages: 1 });
    expect(path.basename(result.normalized)).toBe("normalized.png");
  });

  it("refuses encrypted and active PDFs", async () => {
    await expectCode(
      validateFile(file("encrypted.pdf", encryptedPdf()), directory, "receipt"),
      "encrypted_pdf",
    );
    for (const add of [addJavaScript, addLaunchAction, addEmbeddedFile]) {
      const source = file("active.pdf", await pdfWith(add));
      await expectCode(validateFile(source, directory, "receipt"), "pdf_active_content");
    }
  });

  it("refuses active content wherever it is reachable", async () => {
    const pageAction = await pdfWith((document) => {
      document.getPage(0).node.set(PDFName.of("AA"), document.context.obj({}));
    });
    await expectCode(validateFile(file("aa.pdf", pageAction), directory, "receipt"), "pdf_active_content");
    const remote = await pdfWith((document) => {
      const action = document.context.obj({ S: "GoToR", F: PDFString.of("other.pdf") });
      document.catalog.set(PDFName.of("OpenAction"), document.context.register(action));
    });
    await expectCode(validateFile(file("gotor.pdf", remote), directory, "receipt"), "pdf_active_content");
  });

  it("bounds the objects a PDF may have", async () => {
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    const refs = Array.from({ length: 100_001 }, (_, index) =>
      document.context.register(PDFNumber.of(index)),
    );
    document.catalog.set(PDFName.of("Many"), document.context.obj(refs));
    expect(() => checkPdfObjects(document)).toThrow(DocumentError);
    const source = file("many.pdf", await document.save({ useObjectStreams: false }));
    await expectCode(validateFile(source, directory, "receipt"), "pdf_complexity");
  }, 60_000);

  it("accepts 1 to 30 pages and refuses more, and refuses a PDF as signature", async () => {
    const thirty = file("thirty.pdf", await blankPdf(30));
    expect(await validateFile(thirty, directory, "receipt")).toEqual({
      normalized: thirty,
      mediaType: "application/pdf",
      pages: 30,
    });
    await expectCode(validateFile(file("many.pdf", await blankPdf(31)), directory, "receipt"), "pdf_pages");
    await expectCode(validateFile(thirty, directory, "signature"), "unsupported_type");
  });

  it("refuses pages larger than 14,400 points", async () => {
    await expectCode(
      validateFile(file("wide.pdf", await blankPdf(1, [14_401, 842])), directory, "receipt"),
      "pdf_dimensions",
    );
    const largest = file("largest.pdf", await blankPdf(1, [14_400, 14_400]));
    expect((await validateFile(largest, directory, "receipt")).pages).toBe(1);
  });

  it("refuses a PDF it cannot read", async () => {
    const broken = file("broken.pdf", Buffer.from("%PDF-1.4\nthis is not a PDF\n"));
    await expect(validateFile(broken, directory, "receipt")).rejects.not.toBeInstanceOf(DocumentError);
  });

  it("bounds image dimensions and the serialized output", async () => {
    const source = file("wide.png", await imageBytes({ size: [4000, 1200] }));
    const result = await validateFile(source, path.join(directory, "output"), "receipt");
    const metadata = await sharp(result.normalized).metadata();
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(3508);
    limits.normalizedFileBytes = 100;
    await expectCode(
      validateFile(source, path.join(directory, "limited"), "receipt"),
      "normalized_size_limit",
    );
    expect(existsSync(path.join(directory, "limited", "normalized.jpg"))).toBe(false);
  });

  it("refuses images over the pixel bound", async () => {
    const huge = await sharp({ create: { width: 8000, height: 5001, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    await expect(validateFile(file("huge.png", huge), directory, "receipt")).rejects.not.toBeInstanceOf(
      DocumentError,
    );
  });
});

describe("build", () => {
  it("compresses until the cap is met and keeps every page", async () => {
    const noise = await sharp(seededBytes(42, 1800 * 2400 * 3), {
      raw: { width: 1800, height: 2400, channels: 3 },
    })
      .png()
      .toBuffer();
    const source = file("noise.png", noise);
    const manifest = writeManifest(directory, {
      receipts: [
        { path: source, mediaType: "image/png", label: "Receipt 1" },
        { path: source, mediaType: "image/png", label: "Receipt 2" },
      ],
      maxBytes: 350_000,
    });
    const output = path.join(directory, "result.pdf");
    const result = await buildPdf(manifest, output);
    expect(result.size).toBeLessThanOrEqual(350_000);
    expect(result.dpi).toBeLessThan(160);
    const document = await PDFDocument.load(readFileSync(output));
    expect(document.getPageCount()).toBe(3);
  });

  it("fails visibly when no quality meets the cap, without a partial PDF", async () => {
    const manifest = writeManifest(directory, { receipts: [], maxBytes: 1 });
    const output = path.join(directory, "result.pdf");
    await expectCode(buildPdf(manifest, output), "output_size_limit");
    expect(existsSync(output)).toBe(false);
  });

  it("writes bookmarks per item, the title and the producer", async () => {
    const receipt = file("receipt.png", await imageBytes());
    const multi = file("multi.pdf", await blankPdf(2));
    const manifest = writeManifest(directory, {
      receipts: [
        { path: receipt, mediaType: "image/png", label: "Item 1 · TEST-1" },
        { path: multi, mediaType: "application/pdf", label: "Item 2" },
      ],
      maxBytes: 10_000_000,
      title: "Reimbursement TEST",
    });
    const output = path.join(directory, "result.pdf");
    const result = await buildPdf(manifest, output);
    expect(result).toMatchObject({ pages: 4, dpi: 160, quality: 85 });
    const document = await PDFDocument.load(readFileSync(output), { updateMetadata: false });
    expect(document.getTitle()).toBe("Reimbursement TEST");
    expect(document.getProducer()).toBe("Meldgrove Reimbursement");
    const outlines = document.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const titles: string[] = [];
    const pages: number[] = [];
    const pageRefs = document.getPages().map((page) => page.ref);
    let item = outlines.lookupMaybe(PDFName.of("First"), PDFDict);
    while (item) {
      titles.push((item.lookup(PDFName.of("Title")) as PDFHexString | PDFString).decodeText());
      const destination = item.lookup(PDFName.of("Dest"), PDFArray);
      pages.push(pageRefs.findIndex((ref) => ref === (destination.get(0) as PDFRef)));
      item = item.lookupMaybe(PDFName.of("Next"), PDFDict);
    }
    expect(titles).toEqual(["Item 1 · TEST-1", "Item 2"]);
    expect(pages).toEqual([1, 2]);
    expect(createdHash(result.checksum)).toBe(true);
  });

  it("keeps a filled PDF form visible after normalization", async () => {
    const source = file("filled.pdf", await filledFormPdf());
    expect((await validateFile(source, directory, "receipt")).pages).toBe(1);
    const manifest = writeManifest(directory, {
      receipts: [{ path: source, mediaType: "application/pdf", label: "Filled form" }],
      maxBytes: 1_000_000,
    });
    const output = path.join(directory, "result.pdf");
    await buildPdf(manifest, output);
    const page = await render(output, 1, 1);
    // The black form appearance must survive in the output's upper third.
    let darkest = 255;
    for (let y = 100; y < 300; y += 1) {
      for (let x = 50; x < 300; x += 1) {
        const [red, green, blue] = pixel(page, x, y);
        darkest = Math.min(darkest, Math.floor((red * 299 + green * 587 + blue * 114) / 1000));
      }
    }
    expect(darkest).toBeLessThan(30);
  });

  it("keeps the content and order of a multipage receipt through compression", async () => {
    const colours: Array<[number, number, number]> = [
      [224, 255, 232],
      [255, 241, 213],
      [224, 240, 255],
    ];
    const source = file("receipt.pdf", await colouredPdf(colours));
    const manifest = writeManifest(directory, {
      receipts: [{ path: source, mediaType: "application/pdf", label: "Receipt" }],
      maxBytes: 1_000_000,
    });
    const output = path.join(directory, "complete.pdf");
    await buildPdf(manifest, output);
    for (const [index, colour] of colours.entries()) {
      const page = await render(output, index + 1, 0.5);
      expect(page.count).toBe(4);
      const actual = pixel(page, Math.floor(page.width / 2), Math.floor(page.height / 2));
      expect(Math.max(...actual.map((value, channel) => Math.abs(value - colour[channel]!)))).toBeLessThan(8);
    }
  });

  it("bounds the cumulative size of temporary page images", async () => {
    const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#cee8ff" } })
      .png()
      .toBuffer();
    const document = await PDFDocument.create();
    const embedded = await document.embedPng(image);
    for (let index = 0; index < 2; index += 1) {
      document.addPage([600, 800]).drawImage(embedded, { x: 0, y: 0, width: 600, height: 800 });
    }
    const source = file("two-pages.pdf", await document.save());
    const receipts = [{ path: source, mediaType: "application/pdf", label: "Synthetic" }];
    const baseline = path.join(directory, "baseline");
    mkdirSync(baseline);
    const images = await receiptImages(receipts, baseline);
    expect(images).toHaveLength(2);
    const sizes = new Set(images.map((entry) => statSync(entry.path).size));
    expect(sizes.size).toBe(1);
    const limit = Math.floor(([...sizes][0]! * 3) / 2);
    limits.receiptRasterBytes = limit;
    const bounded = path.join(directory, "bounded");
    mkdirSync(bounded);
    await expectCode(receiptImages(receipts, bounded), "workspace_limit");
    const written = readdirSync(bounded).filter((name) => /^receipt-\d+\.jpg$/.test(name));
    expect(written).toHaveLength(1);
    const total = readdirSync(bounded).reduce(
      (sum, name) => sum + statSync(path.join(bounded, name)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(limit);
  });
});

function createdHash(checksum: string): boolean {
  return /^[0-9a-f]{64}$/.test(checksum);
}
