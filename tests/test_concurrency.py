import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import close_old_connections, connection, connections
from django.test import Client

from portal.models import Claim, Draft, DraftAdmission, Job


@pytest.mark.django_db(transaction=True)
def test_racing_submissions_create_one_claim(prepared):
    if connection.vendor != "postgresql":
        pytest.skip("Row-lock behavior requires PostgreSQL.")
    cookies = prepared["client"].cookies

    def submit():
        close_old_connections()
        try:
            client = Client()
            client.cookies = cookies.copy()
            return client.post(
                "/f/test/submit/",
                data=json.dumps(prepared["data"]),
                content_type="application/json",
            )
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert [result.status_code for result in results] == [202, 202]
    assert results[0].json() == results[1].json()
    assert Claim.objects.count() == 1
    assert Job.objects.filter(kind="render").count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_fresh_sessions_share_one_creation_budget(form, settings):
    if connection.vendor != "postgresql":
        pytest.skip("Row-lock behavior requires PostgreSQL.")
    settings.MAX_DRAFTS_PER_NETWORK = 1

    def open_form(_):
        close_old_connections()
        try:
            return Client().get("/f/test/").status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=4) as pool:
        statuses = list(pool.map(open_form, range(4)))
    assert sorted(statuses) == [200, 429, 429, 429]
    assert Draft.objects.count() == 1
    assert DraftAdmission.objects.get().count == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_references_get_distinct_numbers_even_on_first_use():
    if connection.vendor != "postgresql":
        pytest.skip("Row-lock behavior requires PostgreSQL.")
    from django.utils import timezone

    from portal.services.references import allocate_reference

    def allocate(_):
        close_old_connections()
        try:
            return allocate_reference("werkstatt", "Alex Beispiel", timezone.now())
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=4) as pool:
        references = list(pool.map(allocate, range(4)))
    assert len(set(references)) == 4
    assert sorted(reference.rsplit("/", 1)[1] for reference in references) == [
        "000001",
        "000002",
        "000003",
        "000004",
    ]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("source", ["webhook", "reconciliation"])
def test_operator_retry_and_delivery_evidence_do_not_deadlock(delivery, source):
    import hashlib
    import time
    from queue import Queue

    from django.db import transaction
    from django.utils import timezone

    from portal.models import DeliveryAttempt, DeliveryEvent, Operation
    from portal.services import delivery as deliveries
    from portal.services import operations

    if connection.vendor != "postgresql":
        pytest.skip("Row-lock behavior requires PostgreSQL.")
    delivery.state = "send_unknown"
    delivery.save()
    DeliveryAttempt.objects.create(
        delivery=delivery, state="send_unknown", message_id="concurrent-message"
    )
    event = {
        "type": "activity.delivered",
        "created_at": timezone.now().isoformat(),
        "data": {
            "id": "concurrent-event",
            "recipient": delivery.recipient,
            "message_id": "concurrent-message",
        },
    }
    if source == "reconciliation":
        DeliveryEvent.objects.create(
            provider_id=event["data"]["id"],
            kind=event["type"],
            provider_timestamp=timezone.now(),
            recipient_hash=hashlib.sha256(delivery.recipient.encode()).hexdigest(),
            message_id="concurrent-message",
        )
    backend = Queue()

    def apply_evidence():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                backend.put(cursor.fetchone()[0])
            if source == "webhook":
                deliveries.ingest_event(event)
            else:
                deliveries.reconcile_unmatched()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Claim.objects.select_for_update().get(pk=delivery.claim_id)
            future = pool.submit(apply_evidence)
            evidence_backend = backend.get(timeout=5)
            deadline = time.monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_backend_pid() = ANY(pg_blocking_pids(%s))",
                        [evidence_backend],
                    )
                    blocked = cursor.fetchone()[0]
                if blocked:
                    break
                if future.done():
                    future.result()
                    pytest.fail("Evidence did not wait for the operator's claim lock.")
                assert time.monotonic() < deadline, "Evidence did not reach its claim lock."
                time.sleep(0.01)
            operations.retry(
                delivery.claim_id,
                actor="admin@example.invalid",
                reason="Concurrent delivery check",
                acknowledge_duplicate_risk=True,
            )
        future.result(timeout=10)
    delivery.refresh_from_db()
    assert delivery.state == "delivered"
    assert delivery.claim.retention_due is not None
    assert DeliveryEvent.objects.get(provider_id="concurrent-event").applied
    assert Operation.objects.filter(claim_id=delivery.claim_id, action="retry").count() == 1
