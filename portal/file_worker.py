"""Document conversion, imported after the sandbox bootstrap installs its policy."""

import argparse
import hashlib
import io
import json
import math
import os
import warnings
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageOps
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import DictionaryObject, IndirectObject

from portal.constants import (
    APP_NAME,
    MAX_IMAGE_PIXELS,
    MAX_NORMALIZED_FILE_BYTES,
    MAX_PDF_PAGES,
    MAX_RECEIPT_DIMENSION,
)

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)
MAX_RECEIPT_RASTER_BYTES = 512_000_000
BLOCKED_PDF_KEYS = {
    "/JS",
    "/JavaScript",
    "/Launch",
    "/EmbeddedFiles",
    "/EmbeddedFile",
    "/XFA",
    "/SubmitForm",
    "/ImportData",
    "/RichMedia",
    "/AA",
}


class DocumentError(Exception):
    pass


class BoundedBuffer(io.BytesIO):
    def __init__(self, limit, error_code):
        super().__init__()
        self.limit, self.error_code = limit, error_code

    def write(self, data):
        if self.tell() + len(data) > self.limit:
            raise DocumentError(self.error_code)
        return super().write(data)


def jpeg_bytes(image, quality, *, limit, error_code):
    output = BoundedBuffer(limit, error_code)
    image.save(output, "JPEG", quality=quality, optimize=True)
    return output.getvalue()


def check_pdf_objects(reader):
    pending, seen = [reader.trailer], set()
    while pending:
        obj = pending.pop()
        if isinstance(obj, IndirectObject):
            key = (obj.idnum, obj.generation)
            if key in seen:
                continue
            seen.add(key)
            if len(seen) > 100_000:
                raise DocumentError("pdf_complexity")
            obj = obj.get_object()
        if isinstance(obj, DictionaryObject):
            if BLOCKED_PDF_KEYS.intersection(obj) or obj.get("/S") in {
                "/JavaScript",
                "/Launch",
                "/GoToR",
                "/GoToE",
            }:
                raise DocumentError("pdf_active_content")
            pending.extend(obj.values())
        elif isinstance(obj, list):
            pending.extend(obj)


def normalized_image(source, *, signature=False):
    with Image.open(source) as image:
        if image.format not in {"JPEG", "MPO", "PNG"}:
            raise DocumentError("unsupported_type")
        image.verify()
    with Image.open(source) as image:
        # Camera JPEGs with auxiliary MPO pictures open on their primary image.
        image = ImageOps.exif_transpose(image)
        rgba = image.convert("RGBA")
        clean = Image.new("RGB", rgba.size, "white")
        clean.paste(rgba, mask=rgba.getchannel("A"))
    if signature:
        difference = ImageChops.difference(clean, Image.new("RGB", clean.size, "white"))
        if not difference.convert("L").point(lambda value: 255 if value > 30 else 0).getbbox():
            raise DocumentError("empty_signature")
        clean.thumbnail((2400, 1200), Image.Resampling.LANCZOS)
    else:
        # About 300 DPI on an A4 page; bound derived storage before JPEG encoding.
        clean.thumbnail((MAX_RECEIPT_DIMENSION, MAX_RECEIPT_DIMENSION), Image.Resampling.LANCZOS)
    return clean


def validate_file(source, destination, kind):
    source, destination = Path(source), Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with source.open("rb") as input_file:
        header = input_file.read(12)
    if header.startswith(b"%PDF-"):
        if kind == "signature":
            raise DocumentError("unsupported_type")
        reader = PdfReader(source, strict=True)
        if reader.is_encrypted:
            raise DocumentError("encrypted_pdf")
        count = len(reader.pages)
        if not 1 <= count <= MAX_PDF_PAGES:
            raise DocumentError("pdf_pages")
        check_pdf_objects(reader)
        with pdfium.PdfDocument(source) as document:
            document.init_forms()
            if len(document) != count:
                raise DocumentError("invalid_pdf")
            for page in document:
                width, height = page.get_size()
                page.close()
                if not 1 <= width <= 14_400 or not 1 <= height <= 14_400:
                    raise DocumentError("pdf_dimensions")
        # PDF pages are rasterized at assembly, preserving visible fields and annotations
        # while preventing active objects from entering the authoritative output.
        return {"normalized": str(source), "media_type": "application/pdf", "pages": count}
    if not (header.startswith(b"\x89PNG\r\n\x1a\n") or header.startswith(b"\xff\xd8\xff")):
        raise DocumentError("unsupported_type")
    image = normalized_image(source, signature=kind == "signature")
    normalized = destination / ("normalized.png" if kind == "signature" else "normalized.jpg")
    temporary = normalized.with_suffix(".tmp")
    try:
        if kind == "signature":
            output = BoundedBuffer(MAX_NORMALIZED_FILE_BYTES, "normalized_size_limit")
            image.save(output, "PNG", optimize=True)
            content = output.getvalue()
        else:
            content = jpeg_bytes(
                image, 94, limit=MAX_NORMALIZED_FILE_BYTES, error_code="normalized_size_limit"
            )
        temporary.write_bytes(content)
    finally:
        image.close()
    with temporary.open("rb") as output:
        os.fsync(output.fileno())
    os.replace(temporary, normalized)
    return {
        "normalized": str(normalized),
        "media_type": "image/png" if kind == "signature" else "image/jpeg",
        "pages": 1,
    }


def receipt_images(receipts, workspace):
    images, disk_bytes = [], 0
    for receipt in receipts:
        path = Path(receipt["path"])
        if receipt["media_type"] == "application/pdf":
            with pdfium.PdfDocument(path) as document:
                document.init_forms()
                for page in document:
                    width, height = page.get_size()
                    scale = min(160 / 72, math.sqrt(12_000_000 / (width * height)))
                    bitmap = page.render(scale=scale, may_draw_forms=True, draw_annots=True)
                    image = bitmap.to_pil().convert("RGB")
                    target = workspace / f"receipt-{len(images)}.jpg"
                    try:
                        content = jpeg_bytes(
                            image,
                            95,
                            limit=MAX_RECEIPT_RASTER_BYTES - disk_bytes,
                            error_code="workspace_limit",
                        )
                        target.write_bytes(content)
                    finally:
                        image.close()
                        bitmap.close()
                        page.close()
                    disk_bytes += target.stat().st_size
                    images.append((target, receipt["label"]))
        else:
            images.append((path, receipt["label"]))
    return images


def receipt_page(path, dpi, quality):
    with Image.open(path) as original:
        image = original.convert("RGB")
    landscape = image.width > image.height * 1.1
    width, height = (841.89, 595.28) if landscape else (595.28, 841.89)
    available = (width - 36, height - 36)
    image.thumbnail(
        (int(available[0] / 72 * dpi), int(available[1] / 72 * dpi)), Image.Resampling.LANCZOS
    )
    buffer = io.BytesIO()
    image.save(buffer, "PDF", resolution=dpi, quality=quality, optimize=True)
    image.close()
    source = PdfReader(buffer).pages[0]
    writer = PdfWriter()
    page = writer.add_blank_page(width=width, height=height)
    factor = min(
        available[0] / float(source.mediabox.width), available[1] / float(source.mediabox.height)
    )
    x = (width - float(source.mediabox.width) * factor) / 2
    y = (height - float(source.mediabox.height) * factor) / 2
    page.merge_transformed_page(source, Transformation().scale(factor).translate(x, y))
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def build_pdf(manifest_path, output):
    from weasyprint import HTML
    from weasyprint.urls import URLFetcher

    manifest = json.loads(Path(manifest_path).read_text())
    workspace = Path(output).parent
    allowed = {Path(path).resolve().as_uri() for path in manifest["allowed_assets"]}

    class AllowedFetcher(URLFetcher):
        def fetch(self, url, headers=None):
            if url not in allowed:
                raise DocumentError("blocked_asset")
            return super().fetch(url, headers)

    summary = HTML(
        string=manifest["html"],
        url_fetcher=AllowedFetcher(
            allowed_protocols={"file"}, allow_redirects=False, fail_on_errors=True
        ),
    ).write_pdf()
    images = receipt_images(manifest["receipts"], workspace)
    expected = len(PdfReader(io.BytesIO(summary)).pages) + len(images)
    # Every pass contains the same summary and every receipt page. The cap applies
    # to actual serialized output, never a guessed compression ratio.
    for dpi, quality in [(160, 85), (140, 78), (120, 70), (100, 65), (90, 55), (72, 50)]:
        writer = PdfWriter()
        writer.append(io.BytesIO(summary))
        previous_label = None
        for path, label in images:
            page_start = len(writer.pages)
            writer.append(io.BytesIO(receipt_page(path, dpi, quality)))
            if label != previous_label:
                writer.add_outline_item(label, page_start)
                previous_label = label
        writer.add_metadata(
            {
                "/Title": manifest["title"],
                "/Producer": APP_NAME,
            }
        )
        # Keep each page's content stream independent. Deduplicating streams before
        # compressing individual pages can invalidate another page's shared stream.
        for page in writer.pages:
            page.compress_content_streams()
        buffer = io.BytesIO()
        writer.write(buffer)
        content = buffer.getvalue()
        if len(content) <= manifest["max_bytes"]:
            verification = PdfReader(io.BytesIO(content))
            if len(verification.pages) != expected:
                raise DocumentError("output_page_count")
            for page in verification.pages:
                contents = page.get_contents()
                if contents is None or not contents.get_data().strip():
                    raise DocumentError("output_blank_page")
            with open(output, "wb") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            return {
                "size": len(content),
                "checksum": hashlib.sha256(content).hexdigest(),
                "pages": expected,
                "dpi": dpi,
                "quality": quality,
            }
    # Some pathological inputs cannot meet an arbitrary cap legibly. Never omit
    # pages or send an oversized/partial attachment in order to claim success.
    raise DocumentError("output_size_limit")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["validate", "build"])
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--kind", default="receipt")
    args = parser.parse_args()
    try:
        if args.action == "validate":
            result = validate_file(args.source, args.destination, args.kind)
        else:
            result = build_pdf(args.source, args.destination)
        print(json.dumps(result))
    except Exception as exc:
        # Never return library exceptions containing filenames, document text, or PII.
        print(
            json.dumps(
                {"error": str(exc) if isinstance(exc, DocumentError) else "invalid_document"}
            )
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
