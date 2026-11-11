import json
import random
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from PIL import Image
from pypdf import PdfWriter

from portal.file_worker import DocumentError, build_pdf, receipt_images
from portal.services.capacity import temporary_workspace
from portal.services.documents import (
    assemble_pdf,
    build_claim_pdf,
    inspect_upload,
)

pytestmark = pytest.mark.django_db


def test_multipage_receipt_content_and_order_survive_compression(tmp_path):
    source = tmp_path / "receipt.pdf"
    pages = [Image.new("RGB", (1000, 1400), color) for color in ["#e0ffe8", "#fff1d5", "#e0f0ff"]]
    pages[0].save(source, "PDF", save_all=True, append_images=pages[1:])
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "html": "<h1>Summary</h1>",
                "allowed_assets": [],
                "receipts": [
                    {"path": str(source), "media_type": "application/pdf", "label": "Receipt"}
                ],
                "title": "synthetic",
                "max_bytes": 1_000_000,
            }
        )
    )
    output = tmp_path / "complete.pdf"
    build_pdf(manifest, output)
    expected = [(224, 255, 232), (255, 241, 213), (224, 240, 255)]
    with pdfium.PdfDocument(output) as document:
        assert len(document) == 4
        for index, color in enumerate(expected, 1):
            page = document[index]
            bitmap = page.render(scale=0.5)
            image = bitmap.to_pil().convert("RGB")
            actual = image.getpixel((image.width // 2, image.height // 2))
            assert max(abs(a - b) for a, b in zip(actual, color, strict=True)) < 8, (index, actual)
            bitmap.close()
            page.close()


def test_summary_text_stays_inside_page_margins(accepted):
    with temporary_workspace() as workspace:
        output, _ = build_claim_pdf(accepted, workspace)
        with pdfium.PdfDocument(output) as document:
            page = document[0]
            text = page.get_textpage()
            boxes = [text.get_charbox(index) for index in range(text.count_chars())]
            assert max(box[2] for box in boxes) <= page.get_width() - 30
            text.close()
            page.close()


def test_maximum_receipt_page_count_survives_confined_assembly(tmp_path):
    receipts = []
    for index, count in enumerate([30, 30, 30, 10]):
        source = tmp_path / f"receipt-{index}.pdf"
        writer = PdfWriter()
        for _ in range(count):
            writer.add_blank_page(595, 842)
        writer.write(source)
        receipts.append(
            {"path": str(source), "media_type": "application/pdf", "label": f"Receipt {index}"}
        )
    with temporary_workspace() as workspace:
        manifest = Path(workspace) / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "html": "<h1>Synthetic maximum-page claim</h1>",
                    "allowed_assets": [],
                    "receipts": receipts,
                    "title": "synthetic",
                    "max_bytes": 10_000_000,
                }
            )
        )
        output = manifest.parent / "complete.pdf"
        result = assemble_pdf(manifest, output)
        assert result["pages"] == 101
        assert 0 < output.stat().st_size <= 10_000_000
        with pdfium.PdfDocument(output) as document:
            assert len(document) == 101


def test_large_pdf_rasters_reach_final_compression_with_all_pages(tmp_path):
    source = tmp_path / "detail.pdf"
    pages = [
        Image.frombytes("1", (3000, 4000), random.Random(seed).randbytes(1_500_000))
        for seed in [42, 43]
    ]
    try:
        pages[0].save(source, "PDF", resolution=160, save_all=True, append_images=pages[1:])
    finally:
        for page in pages:
            page.close()
    assert source.stat().st_size < 10_000_000
    with temporary_workspace() as workspace:
        workspace = Path(workspace)
        validated = inspect_upload(source, workspace)
        assert validated["pages"] == 2
        manifest = workspace / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "html": "<h1>Synthetic high-detail claim</h1>",
                    "allowed_assets": [],
                    "receipts": [
                        {"path": str(source), "media_type": "application/pdf", "label": "Detail"}
                    ],
                    "title": "synthetic",
                    "max_bytes": 1_000_000,
                }
            )
        )
        output = workspace / "complete.pdf"
        result = assemble_pdf(manifest, output)
        rasters = list(workspace.glob("receipt-*.jpg"))
        assert len(rasters) == 2
        assert all(path.stat().st_size > 10_000_000 for path in rasters)
        assert result["size"] <= 1_000_000
        assert result["pages"] == 3
        with pdfium.PdfDocument(output) as document:
            assert len(document) == 3


def test_raster_budget_limits_cumulative_temporary_jpegs(tmp_path, monkeypatch):
    source = tmp_path / "two-pages.pdf"
    image = Image.new("RGB", (600, 800), "#cee8ff")
    try:
        image.save(source, "PDF", save_all=True, append_images=[image])
    finally:
        image.close()
    receipts = [{"path": str(source), "media_type": "application/pdf", "label": "Synthetic"}]
    baseline = tmp_path / "baseline"
    baseline.mkdir()
    images = receipt_images(receipts, baseline)
    assert len(images) == 2
    sizes = {path.stat().st_size for path, _ in images}
    assert len(sizes) == 1
    limit = sizes.pop() * 3 // 2
    monkeypatch.setattr("portal.file_worker.MAX_RECEIPT_RASTER_BYTES", limit)
    bounded = tmp_path / "bounded"
    bounded.mkdir()
    with pytest.raises(DocumentError, match="workspace_limit"):
        receipt_images(receipts, bounded)
    assert len(list(bounded.glob("receipt-*.jpg"))) == 1
    assert sum(path.stat().st_size for path in bounded.iterdir()) <= limit
