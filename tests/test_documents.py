import io
import json
import random

import pypdfium2 as pdfium
import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject

from portal.file_worker import DocumentError, build_pdf, validate_file
from portal.jobs import run_one
from portal.models import Claim, Job
from portal.services.capacity import temporary_workspace
from portal.services.documents import build_claim_pdf
from tests.conftest import camera_jpeg_bytes, image_bytes

pytestmark = pytest.mark.django_db


def test_real_image_validation_and_metadata_removal(tmp_path):
    source = tmp_path / "receipt.png"
    source.write_bytes(image_bytes())
    result = validate_file(source, tmp_path / "clean", "receipt")
    assert result["pages"] == 1
    with Image.open(result["normalized"]) as image:
        assert image.mode == "RGB"
        assert not image.getexif()


def test_blank_signature_and_mislabeled_documents_rejected(tmp_path):
    source = tmp_path / "signature.png"
    Image.new("RGBA", (300, 100), (0, 0, 0, 0)).save(source)
    with pytest.raises(DocumentError, match="empty_signature"):
        validate_file(source, tmp_path / "clean", "signature")
    source.write_bytes(b"<svg>not an image</svg>")
    with pytest.raises(DocumentError, match="unsupported_type"):
        validate_file(source, tmp_path / "clean", "receipt")


def test_blank_camera_signature_cannot_use_ink_from_an_auxiliary_picture(tmp_path):
    source = tmp_path / "signature.jpg"
    source.write_bytes(camera_jpeg_bytes(primary_color="white"))
    with pytest.raises(DocumentError, match="empty_signature"):
        validate_file(source, tmp_path / "clean", "signature")


def test_encrypted_and_active_pdfs_rejected(tmp_path):
    source = tmp_path / "receipt.pdf"
    writer = PdfWriter()
    writer.add_blank_page(595, 842)
    writer.encrypt("test-password")
    writer.write(source)
    with pytest.raises(DocumentError, match="encrypted_pdf"):
        validate_file(source, tmp_path, "receipt")
    writer = PdfWriter()
    writer.add_blank_page(595, 842)
    writer.add_js("app.alert('test')")
    writer.write(source)
    with pytest.raises(DocumentError, match="pdf_active_content"):
        validate_file(source, tmp_path, "receipt")


def test_adaptive_compression_meets_cap_and_keeps_all_pages(tmp_path):
    source = tmp_path / "noise.png"
    rng = random.Random(42)
    Image.frombytes("RGB", (1800, 2400), rng.randbytes(1800 * 2400 * 3)).save(source)
    writer = PdfWriter()
    writer.add_blank_page(595, 842)
    buffer = io.BytesIO()
    writer.write(buffer)
    # Use a real generated summary, not a mocked renderer.
    manifest = {
        "html": "<html><body><h1>Compression test</h1></body></html>",
        "allowed_assets": [],
        "receipts": [
            {"path": str(source), "media_type": "image/png", "label": "Receipt 1"},
            {"path": str(source), "media_type": "image/png", "label": "Receipt 2"},
        ],
        "title": "synthetic",
        "max_bytes": 350_000,
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    output = tmp_path / "result.pdf"
    result = build_pdf(path, output)
    assert result["size"] <= 350_000
    assert result["dpi"] < 160
    assert len(PdfReader(output).pages) == 3


def test_impossible_cap_is_a_visible_failure_not_partial_pdf(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "html": "<p>Summary</p>",
                "allowed_assets": [],
                "receipts": [],
                "title": "test",
                "max_bytes": 1,
            }
        )
    )
    output = tmp_path / "result.pdf"
    with pytest.raises(DocumentError, match="output_size_limit"):
        build_pdf(path, output)
    assert not output.exists()


def test_authoritative_pdf_contains_source_form_fields_and_signature(accepted):
    with temporary_workspace() as directory:
        path, result = build_claim_pdf(accepted, directory)
        reader = PdfReader(path)
        text = " ".join(" ".join(page.extract_text() for page in reader.pages).split())
        assert "Alex Beispiel" in text and "DE89370400440532013000" in text
        assert "TEST-KST" in text and "TEST-KTR" in text
        # pypdf can insert spaces between kerned glyphs such as "T est".
        assert "Belegverkauf" in "".join(text.split()) and "bisher nicht erstattet" in text
        assert "12,50" in text
        assert result["pages"] == 2
        assert len(reader.pages[0].images) >= 1
        assert reader.outline
        assert reader.metadata.title == f"Erstattung {accepted.reference}"
        assert reader.metadata.producer == "Meldgrove Reimbursement"


def test_the_pdf_uses_the_language_its_participant_saw(accepted):
    accepted.snapshot["language"] = "en"
    accepted.save()
    with temporary_workspace() as directory:
        path, _ = build_claim_pdf(accepted, directory)
        reader = PdfReader(path)
        text = " ".join(reader.pages[0].extract_text().split())
        assert "Reimbursement form" in text and "Erstattungsformular" not in text
        assert reader.metadata.title == f"Reimbursement {accepted.reference}"


def test_filled_pdf_form_remains_visible_after_normalization(tmp_path):
    source = tmp_path / "filled.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(595, 842)
    # Form field with an appearance stream, as commonly supplied on receipts.
    from pypdf.generic import DecodedStreamObject

    appearance = DecodedStreamObject()
    appearance.set_data(b"q 0 0 0 rg 0 0 180 45 re f Q")
    appearance.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): ArrayObject(
                [FloatObject(0), FloatObject(0), FloatObject(180), FloatObject(45)]
            ),
        }
    )
    field = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject("amount"),
            NameObject("/V"): TextStringObject("12.50"),
            NameObject("/Rect"): ArrayObject(
                [FloatObject(80), FloatObject(600), FloatObject(260), FloatObject(645)]
            ),
            NameObject("/AP"): DictionaryObject({NameObject("/N"): writer._add_object(appearance)}),
        }
    )
    field_ref = writer._add_object(field)
    page[NameObject("/Annots")] = ArrayObject([field_ref])
    writer._root_object[NameObject("/AcroForm")] = DictionaryObject(
        {NameObject("/Fields"): ArrayObject([field_ref])}
    )
    writer.write(source)
    assert validate_file(source, tmp_path, "receipt")["pages"] == 1
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "html": "<p>Summary</p>",
                "allowed_assets": [],
                "receipts": [
                    {"path": str(source), "media_type": "application/pdf", "label": "Filled form"}
                ],
                "title": "test",
                "max_bytes": 1_000_000,
            }
        )
    )
    output = tmp_path / "result.pdf"
    build_pdf(manifest, output)
    with pdfium.PdfDocument(output) as document:
        page = document[1]
        bitmap = page.render(scale=1)
        image = bitmap.to_pil()
        # The black form appearance must survive in the output's upper third.
        assert min(image.convert("L").crop((50, 100, 300, 300)).getextrema()) < 30
        bitmap.close()
        page.close()


def test_pipeline_sends_finance_pdf_and_participant_confirmation(accepted, settings):
    while run_one():
        pass
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.READY, accepted.error_code
    assert accepted.delivery.state == "delivered"
    assert accepted.retention_due
    assert accepted.pdf_size <= settings.MAX_FINAL_PDF_BYTES
    from email import policy
    from email.parser import BytesParser

    files = list((settings.PRIVATE_STORAGE_ROOT / "outbox").glob("*.eml"))
    assert len(files) == 2
    messages = [BytesParser(policy=policy.default).parsebytes(file.read_bytes()) for file in files]
    message = next(
        message for message in messages if message["To"] == accepted.snapshot["recipient"]
    )
    attachment = list(message.iter_attachments())[0]
    assert attachment.get_content_type() == "application/pdf"
    assert len(PdfReader(io.BytesIO(attachment.get_payload(decode=True))).pages) == 2
    assert not Job.objects.filter(state="pending").exists()
