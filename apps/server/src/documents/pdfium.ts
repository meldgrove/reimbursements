/**
 * PDFium (the PDF engine of Chrome, as WebAssembly) for the document child:
 * page counts, page sizes and rendering with form fields and annotations, as
 * pypdfium2 did in the Django version. Only the child loads it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

/** FPDF_ANNOT: draw annotations; FPDF_REVERSE_BYTE_ORDER: RGBA instead of BGRA. */
const RENDER_FLAGS = 0x01 | 0x10;

let loading: Promise<WrappedPdfiumModule> | undefined;

/** The module's memory (Emscripten's HEAPU8, which the typings leave out). */
function heap(module: WrappedPdfiumModule): Uint8Array {
  return (module.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

function wasmPath(): string {
  return createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm");
}

/** The PDFium module, loaded once per process. */
export function pdfium(): Promise<WrappedPdfiumModule> {
  loading ??= (async () => {
    // The binary is read here, so the module never fetches or locates files itself.
    const wasmBinary = readFileSync(wasmPath());
    const module = await init({
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength,
      ) as ArrayBuffer,
    });
    module.PDFiumExt_Init();
    return module;
  })();
  return loading;
}

export type RenderedPage = { width: number; height: number; rgba: Uint8Array };

/** One PDF opened in PDFium. Close it: its memory is the module's. */
export class PdfiumDocument {
  private form = 0;
  private formInfo = 0;

  private constructor(
    private readonly module: WrappedPdfiumModule,
    private readonly document: number,
    private readonly memory: number,
  ) {}

  /** Opens `bytes`; throws when PDFium cannot read them. */
  static async open(bytes: Uint8Array): Promise<PdfiumDocument> {
    const module = await pdfium();
    const memory = module.pdfium.wasmExports.malloc(bytes.byteLength);
    if (!memory) throw new Error("pdfium: out of memory");
    heap(module).set(bytes, memory);
    const document = module.FPDF_LoadMemDocument(memory, bytes.byteLength, "");
    if (!document) {
      module.pdfium.wasmExports.free(memory);
      throw new Error(`pdfium: cannot open the document (${module.FPDF_GetLastError()})`);
    }
    return new PdfiumDocument(module, document, memory);
  }

  /** Sets up the form fill environment, so field appearances render (pypdfium2's init_forms). */
  initForms(): void {
    if (this.form) return;
    this.formInfo = this.module.PDFiumExt_OpenFormFillInfo();
    this.form = this.module.PDFiumExt_InitFormFillEnvironment(this.document, this.formInfo);
    if (!this.form) throw new Error("pdfium: cannot set up forms");
  }

  pageCount(): number {
    return this.module.FPDF_GetPageCount(this.document);
  }

  /** The page's width and height in points. */
  pageSize(index: number): { width: number; height: number } {
    return this.withPage(index, (page) => ({
      width: this.module.FPDF_GetPageWidthF(page),
      height: this.module.FPDF_GetPageHeightF(page),
    }));
  }

  /** The page at `scale` (1: 72 dpi) on white, with annotations and form fields, as RGBA. */
  render(index: number, scale: number): RenderedPage {
    return this.withPage(index, (page) => {
      const width = Math.max(1, Math.round(this.module.FPDF_GetPageWidthF(page) * scale));
      const height = Math.max(1, Math.round(this.module.FPDF_GetPageHeightF(page) * scale));
      const bitmap = this.module.FPDFBitmap_Create(width, height, 0);
      if (!bitmap) throw new Error("pdfium: out of memory");
      try {
        this.module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        this.module.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS);
        if (this.form)
          this.module.FPDF_FFLDraw(this.form, bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS);
        const buffer = this.module.FPDFBitmap_GetBuffer(bitmap);
        const stride = this.module.FPDFBitmap_GetStride(bitmap);
        const memory = heap(this.module);
        const rgba = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row += 1) {
          rgba.set(
            memory.subarray(buffer + row * stride, buffer + row * stride + width * 4),
            row * width * 4,
          );
        }
        return { width, height, rgba };
      } finally {
        this.module.FPDFBitmap_Destroy(bitmap);
      }
    });
  }

  close(): void {
    if (this.form) {
      this.module.PDFiumExt_ExitFormFillEnvironment(this.form);
      this.module.PDFiumExt_CloseFormFillInfo(this.formInfo);
      this.form = 0;
    }
    this.module.FPDF_CloseDocument(this.document);
    this.module.pdfium.wasmExports.free(this.memory);
  }

  private withPage<T>(index: number, use: (page: number) => T): T {
    const page = this.module.FPDF_LoadPage(this.document, index);
    if (!page) throw new Error("pdfium: cannot load a page");
    if (this.form) this.module.FORM_OnAfterLoadPage(page, this.form);
    try {
      return use(page);
    } finally {
      if (this.form) this.module.FORM_OnBeforeClosePage(page, this.form);
      this.module.FPDF_ClosePage(page);
    }
  }
}
