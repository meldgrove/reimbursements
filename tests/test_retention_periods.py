from datetime import timedelta
from importlib import import_module

import pytest
from django.apps import apps
from django.utils import timezone

from portal.models import Claim, DeliveryAttempt, Form, PrivacyNotice
from portal.privacy_notice import DEFAULT_PRIVACY_NOTICE
from portal.services import delivery as deliveries
from portal.services import operations, retention
from portal.services.retention import cleanup
from portal.services.storage import path_for

pytestmark = pytest.mark.django_db
MIGRATION = import_module("portal.migrations.0008_content_retention_ninety_days")


def delivered(delivery):
    DeliveryAttempt.objects.create(delivery=delivery, state="delivered", message_id="message-1")
    deliveries.refresh(delivery)
    claim = Claim.objects.get(pk=delivery.claim_id)
    return claim


def test_delivery_schedules_pdf_and_content_deletion(delivery, settings):
    claim = delivered(delivery)
    delivery.refresh_from_db()
    assert claim.pdf_due == delivery.delivered_at + timedelta(days=settings.PDF_RETENTION_DAYS)
    assert claim.retention_due == claim.submitted_at + timedelta(
        days=settings.CONTENT_RETENTION_DAYS
    )


@pytest.mark.parametrize(
    ("state", "dated"),
    [("delivered", True), ("failed", False), ("send_unknown", False), ("provider_accepted", None)],
)
def test_retention_follows_the_finance_delivery(accepted, settings, state, dated):
    accepted.pdf_due = accepted.retention_due = earlier = timezone.now()
    delivered_at = accepted.submitted_at + timedelta(days=100)
    retention.follow_delivery(accepted, state, delivered_at)
    accepted.refresh_from_db()
    if dated is None:
        # Not resolved either way: the stored dates stay as they were.
        assert accepted.pdf_due == accepted.retention_due != earlier
    elif dated:
        assert accepted.pdf_due == delivered_at + timedelta(days=settings.PDF_RETENTION_DAYS)
        # Content stays at least as long as the PDF.
        assert accepted.retention_due == accepted.pdf_due
    else:
        assert accepted.pdf_due is None and accepted.retention_due is None


def test_pdf_is_deleted_first_and_content_after_ninety_days(delivery):
    claim = delivered(delivery)
    pdf = path_for(claim.pdf_key)
    Claim.objects.filter(pk=claim.pk).update(pdf_due=timezone.now() - timedelta(seconds=1))
    assert cleanup()["pdfs_due"] == 1
    result = cleanup(execute=True)
    assert result["failures"] == 0
    claim.refresh_from_db()
    assert not pdf.exists() and claim.pdf_key == "" and claim.pdf_removed_at
    assert claim.state == Claim.State.READY and claim.iban and claim.uploads.count() == 2
    Claim.objects.filter(pk=claim.pk).update(retention_due=timezone.now() - timedelta(seconds=1))
    cleanup(execute=True)
    assert not Claim.objects.filter(pk=claim.pk).exists()


def test_failed_delivery_keeps_the_pdf_for_resolution(delivery):
    DeliveryAttempt.objects.create(delivery=delivery, state="failed")
    deliveries.refresh(delivery)
    claim = Claim.objects.get(pk=delivery.claim_id)
    assert claim.pdf_due is None and claim.retention_due is None
    cleanup(execute=True)
    claim.refresh_from_db()
    assert claim.pdf_key


def test_an_archived_claim_needs_no_resolution_and_goes_on_its_resolution_date(delivery):
    DeliveryAttempt.objects.create(delivery=delivery, state="failed")
    deliveries.refresh(delivery)
    claim = Claim.objects.get(pk=delivery.claim_id)
    past = timezone.now() - timedelta(seconds=1)
    Claim.objects.filter(pk=claim.pk).update(resolution_due=past)
    assert cleanup()["unresolved_near_expiry"] == 1
    cleanup(execute=True)
    assert Claim.objects.filter(pk=claim.pk).exists()

    operations.archive([claim.pk], actor="admin")
    claim.refresh_from_db()
    assert retention.content_due(claim) == past and claim.retention_due is None
    result = cleanup()
    assert (result["claims_due"], result["unresolved_near_expiry"]) == (1, 0)
    cleanup(execute=True)
    assert not Claim.objects.filter(pk=claim.pk).exists()
    assert not path_for("pdf/test.pdf").exists()


def test_an_archived_claim_waits_for_its_resolution_or_retention_date(delivery):
    Claim.objects.filter(pk=delivery.claim_id).update(archived_at=timezone.now())
    claim = Claim.objects.get(pk=delivery.claim_id)
    assert retention.content_due(claim) == claim.resolution_due > timezone.now()
    cleanup(execute=True)
    assert Claim.objects.filter(pk=claim.pk).exists()
    # Once resolved, the retention date decides, as for any claim.
    claim = delivered(delivery)
    assert retention.content_due(claim) == claim.retention_due
    Claim.objects.filter(pk=claim.pk).update(resolution_due=timezone.now() - timedelta(seconds=1))
    cleanup(execute=True)
    assert Claim.objects.filter(pk=claim.pk).exists()
    Claim.objects.filter(pk=claim.pk).update(retention_due=timezone.now() - timedelta(seconds=1))
    cleanup(execute=True)
    assert not Claim.objects.filter(pk=claim.pk).exists()


def test_archived_forms_are_never_purged(form):
    form.status = Form.Status.ARCHIVED
    form.save()
    cleanup(execute=True)
    assert Form.objects.filter(pk=form.pk, status=Form.Status.ARCHIVED).exists()


def test_privacy_texts_state_the_retention_periods(client, form, settings):
    assert (settings.PDF_RETENTION_DAYS, settings.CONTENT_RETENTION_DAYS) == (7, 90)
    page = client.get("/f/test/").content.decode()
    for text in (DEFAULT_PRIVACY_NOTICE, page):
        assert f"{settings.PDF_RETENTION_DAYS} Tage nach der Zustellung an die Buchhaltung" in text
        assert f"{settings.CONTENT_RETENTION_DAYS} Tage nach dem Einreichen" in text


def test_migration_publishes_the_ninety_day_period_in_the_current_notice():
    old = DEFAULT_PRIVACY_NOTICE.replace(
        "90 Tage nach dem Einreichen", "30 Tage nach dem Einreichen"
    )
    previous = PrivacyNotice.objects.create(text=old, created_by="admin@example.invalid")
    MIGRATION.publish(apps, None)
    current = PrivacyNotice.current()
    assert current.version == previous.version + 1 and current.text == DEFAULT_PRIVACY_NOTICE
    MIGRATION.publish(apps, None)
    assert PrivacyNotice.current() == current


def test_migration_leaves_a_rewritten_notice_alone():
    rewritten = PrivacyNotice.objects.create(text="Synthetic rewritten notice.")
    MIGRATION.publish(apps, None)
    assert PrivacyNotice.current() == rewritten


def test_migration_keeps_existing_claims_for_ninety_days(delivery):
    claim = delivered(delivery)
    thirty, ninety = (claim.submitted_at + timedelta(days=days) for days in (30, 90))
    Claim.objects.filter(pk=claim.pk).update(retention_due=thirty, resolution_due=thirty)
    MIGRATION.extend(apps, None)
    claim.refresh_from_db()
    assert claim.retention_due == ninety and claim.resolution_due == ninety
