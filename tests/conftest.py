import hashlib
import io
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image, ImageDraw

from portal import dates
from portal.models import (
    Claim,
    Delivery,
    Draft,
    Form,
    FormTemplate,
    Job,
    PrivacyNotice,
    TemplateField,
    Upload,
)
from portal.services.storage import path_for


@dataclass
class Participant:
    """An in-memory participant: a browser session and its remembered drafts."""

    network: str = "192.0.2.1/32"
    session: str | None = None
    memory: dict = field(default_factory=dict)

    def binding(self, *, create=False):
        if self.session is None and create:
            self.session = uuid.uuid4().hex
        return self.session

    def remembered(self, form_slug):
        return self.memory.get(form_slug)

    def remember(self, form_slug, draft_id, token):
        self.memory[form_slug] = (str(draft_id), token)


@pytest.fixture(autouse=True)
def local_settings(settings, tmp_path):
    settings.DEBUG = True
    settings.PRIVATE_STORAGE_ROOT = tmp_path / "private"
    settings.PRIVATE_STORAGE_ROOT.mkdir()
    settings.FILE_UPLOAD_TEMP_DIR = str(settings.PRIVATE_STORAGE_ROOT / "incoming")
    (settings.PRIVATE_STORAGE_ROOT / "incoming").mkdir()
    settings.STATIC_ROOT = tmp_path / "staticfiles"
    settings.STATIC_ROOT.mkdir()
    settings.UPLOAD_SCANNER = "disabled"
    settings.MAIL_DELIVERY_MODE = "local"
    settings.MIN_FREE_STORAGE_BYTES = 0
    settings.APPROVED_DELIVERY_RECIPIENTS = ["finance@example.invalid"]
    settings.TEST_RECIPIENT_ALLOWLIST = []
    yield
    # Requests and jobs set the app date format for the whole process; start each test
    # with the default.
    dates.use(dates.DEFAULT_DATE_FORMAT)


class FakeDisk:
    """A fixed-size disk adapter. `workspace_free` models a separate tmpfs at private/work."""

    def __init__(self, free, *, workspace_free=None):
        self.free_bytes, self.workspace_free = free, workspace_free

    def free(self, path):
        if self.workspace_free is not None and Path(path).name == "work":
            return self.workspace_free
        return self.free_bytes

    def shared(self, path, root):
        return self.workspace_free is None


@pytest.fixture
def fake_disk(monkeypatch):
    def install(free, **options):
        monkeypatch.setattr("portal.services.capacity.disk", FakeDisk(free, **options))

    return install


@pytest.fixture
def template(db):
    template, _ = FormTemplate.objects.get_or_create(
        name="Test-Vorlage", defaults={"travel": "optional", "mileage_enabled": True}
    )
    TemplateField.objects.get_or_create(
        template=template, key="kst", defaults={"label": "Kostenstelle (KST)", "position": 0}
    )
    TemplateField.objects.get_or_create(
        template=template,
        key="ktr",
        defaults={"label": "Kostenträger (KTR)", "required": False, "position": 1},
    )
    return template


@pytest.fixture
def privacy_notice(db):
    # Transactional tests flush the notice the migrations create.
    return PrivacyNotice.current() or PrivacyNotice.objects.create(
        text="Synthetic privacy notice for tests."
    )


@pytest.fixture
def form(template, privacy_notice):
    return Form.objects.create(
        template=template,
        slug="test",
        name="Test Workshop",
        field_values={"kst": "TEST-KST", "ktr": "TEST-KTR"},
        recipient="finance@example.invalid",
        support_email="finance@example.invalid",
        status=Form.Status.PUBLISHED,
    )


def image_bytes(*, signature=False, color="white", size=(900, 1200)):
    image = Image.new("RGB", (800, 240) if signature else size, color)
    drawing = ImageDraw.Draw(image)
    if signature:
        drawing.line(
            [(80, 160), (150, 60), (210, 170), (300, 80), (440, 150), (600, 100)],
            fill="#134e4a",
            width=5,
        )
    else:
        drawing.text((50, 60), "SYNTHETIC RECEIPT - TEST ONLY", fill="black")
        drawing.text((50, 110), "Total EUR 12.50", fill="black")
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def camera_jpeg_bytes(*, primary_color="forestgreen"):
    """A JPEG with an MPF header and a separate auxiliary picture."""
    primary = Image.new("RGB", (320, 180), primary_color)
    auxiliary = Image.new("RGB", (80, 60), "red")
    exif = Image.Exif()
    exif[274] = 6  # Camera orientation, 90 degrees clockwise.
    exif[270] = "Synthetic private camera metadata"
    output = io.BytesIO()
    primary.save(output, "MPO", save_all=True, append_images=[auxiliary], exif=exif)
    return output.getvalue()


@pytest.fixture
def prepared(client, form):
    response = client.get(f"/f/{form.slug}/")
    assert response.status_code == 200
    draft = Draft.objects.get()
    token = client.session[f"draft:{form.slug}"]["token"]
    row_id = uuid.uuid4()
    receipt_id, signature_id = uuid.uuid4(), uuid.uuid4()
    for upload_id, kind in [(receipt_id, "receipt"), (signature_id, "signature")]:
        content = image_bytes(signature=kind == "signature")
        key = f"uploads/{upload_id}/normalized.png"
        path = path_for(key)
        path.parent.mkdir(parents=True)
        path.write_bytes(content)
        Upload.objects.create(
            id=upload_id,
            draft=draft,
            kind=kind,
            expense_id=row_id if kind == "receipt" else None,
            original_name=f"{kind}.png",
            source_key=key,
            normalized_key=key,
            size=len(content),
            checksum=hashlib.sha256(content).hexdigest(),
            state="ready",
            media_type="image/png",
            pages=1,
        )
    data = {
        "draft_id": str(draft.id),
        "token": token,
        "full_name": "Alex Beispiel",
        "email": "participant@example.invalid",
        "street": "Teststraße 1",
        "postal_code": "12345",
        "city": "Berlin",
        "country": "DE",
        "account_holder": "Alex Beispiel",
        "iban": "DE89 3704 0044 0532 0130 00",
        "bic": "",
        "purpose": "Teilnahme am synthetischen Workshop",
        "purpose_details": "",
        "is_trip": True,
        "trip_destination": "Berlin",
        "trip_start": "2026-10-20",
        "trip_end": "2026-10-21",
        "declaration": True,
        "privacy_acknowledged": True,
        "signature": str(signature_id),
        "expenses": [
            {
                "id": str(row_id),
                "merchant": "Belegverkauf",
                "purpose": "Workshop-Anreise",
                "receipt_reference": "TEST-1",
                "amount": "12,50",
                "uploads": [str(receipt_id)],
            }
        ],
    }
    return {"client": client, "form": form, "draft": draft, "data": data}


@pytest.fixture
def accepted(prepared):
    response = prepared["client"].post(
        "/f/test/submit/", data=json.dumps(prepared["data"]), content_type="application/json"
    )
    assert response.status_code == 202, response.content
    return Claim.objects.get()


@pytest.fixture
def delivery(accepted):
    """An accepted claim with a ready synthetic PDF and no queued jobs."""
    Job.objects.all().delete()
    content = b"%PDF-1.4 synthetic provider unit fixture"
    path = path_for("pdf/test.pdf")
    path.parent.mkdir(parents=True)
    path.write_bytes(content)
    accepted.state, accepted.pdf_key = Claim.State.READY, "pdf/test.pdf"
    accepted.pdf_hash, accepted.pdf_size = hashlib.sha256(content).hexdigest(), len(content)
    accepted.save()
    return Delivery.objects.create(claim=accepted, recipient="finance@example.invalid")


@pytest.fixture
def uploaded_file():
    return SimpleUploadedFile("receipt.png", image_bytes(), content_type="image/png")
