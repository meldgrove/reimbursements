"""Synthetic HTTP intake load. Run only through the disposable capacity Compose stack."""

import concurrent.futures
import io
import json
import random
import re
import ssl
import statistics
import sys
import time
import uuid

import httpx
from PIL import Image, ImageDraw

BASE = "http://web:8000"
# The first purpose option of the demo form (portal/management/commands/seed_demo.py).
DEMO_PURPOSE = "Teilnahme an der Werkstatt zur Förderung des bürgerschaftlichen Engagements"
CONTEXT = ssl.create_default_context()


def image(signature=False):
    picture = Image.new("RGB", (800, 240) if signature else (1000, 1400), "white")
    draw = ImageDraw.Draw(picture)
    draw.text((40, 40), "SYNTHETIC CAPACITY RECEIPT", fill="black")
    if signature:
        draw.line([(50, 160), (150, 50), (250, 170), (400, 80), (650, 140)], fill="black", width=4)
    output = io.BytesIO()
    picture.save(output, "PNG")
    return output.getvalue()


RECEIPT, SIGNATURE = image(), image(True)


def participant(index):
    started = time.monotonic()
    with httpx.Client(base_url=BASE, verify=CONTEXT, timeout=30, trust_env=False) as client:
        response = client.get("/f/demo/")
        response.raise_for_status()
        config = json.loads(
            re.search(
                r'<script id="portal-configuration"[^>]*>(.*?)</script>', response.text, re.S
            )[1]
        )
        client.headers["X-CSRFToken"] = client.cookies["csrftoken"]
        client.headers["X-Draft-Token"] = config["token"]
        rows, pending, ready_times = [], [], []
        for position in range(2):
            row = {
                "id": str(uuid.uuid4()),
                "merchant": "Synthetic Rail",
                "purpose": "Capacity check",
                "receipt_reference": str(position + 1),
                "amount": "12,50",
            }
            upload = client.post(
                config["upload_url"],
                data={
                    "draft_id": config["draft_id"],
                    "token": config["token"],
                    "kind": "receipt",
                    "expense_id": row["id"],
                },
                files={"file": ("synthetic.png", RECEIPT, "image/png")},
            )
            upload.raise_for_status()
            record = upload.json()
            pending.append((record, time.monotonic()))
            row["uploads"] = [record["id"]]
            rows.append(row)
        signature = client.post(
            config["upload_url"],
            data={"draft_id": config["draft_id"], "token": config["token"], "kind": "signature"},
            files={"file": ("signature.png", SIGNATURE, "image/png")},
        )
        signature.raise_for_status()
        signature = signature.json()
        pending.append((signature, time.monotonic()))
        attempt = 0
        while pending:
            if time.monotonic() - started > 900:
                raise TimeoutError("Validation exceeded the 15-minute capacity target")
            time.sleep(min(10, 2 * 1.4 ** min(attempt, 8)) * random.uniform(1, 1.2))
            attempt += 1
            for record, uploaded_at in list(pending):
                response = client.get(record["status_url"])
                response.raise_for_status()
                state = response.json()["state"]
                if state == "failed":
                    raise RuntimeError("Synthetic validation failed")
                if state == "ready":
                    ready_times.append(time.monotonic() - uploaded_at)
                    pending.remove((record, uploaded_at))
        submitted = time.monotonic()
        response = client.post(
            config["submit_url"],
            json={
                "draft_id": config["draft_id"],
                "token": config["token"],
                "signature": signature["id"],
                "declaration": True,
                "privacy_acknowledged": True,
                "full_name": "Synthetic Participant",
                "street": "Teststrasse 1",
                "postal_code": "12345",
                "city": "Berlin",
                "country": "DE",
                "account_holder": "Synthetic Participant",
                "email": "capacity@example.invalid",
                "iban": "DE89370400440532013000",
                "purpose": DEMO_PURPOSE,
                "is_trip": True,
                "trip_destination": "Berlin",
                "trip_start": "2026-10-20",
                "trip_end": "2026-10-21",
                "expenses": rows,
            },
        )
        response.raise_for_status()
        receipt_url = response.json()["receipt_url"]
        while True:
            if time.monotonic() - started > 900:
                raise TimeoutError("Handoff exceeded the 15-minute capacity target")
            response = client.get(receipt_url + "?format=json")
            response.raise_for_status()
            state = response.json()["state"]
            if state == "delivered":
                break
            if state in {"failed", "processing_failed", "send_unknown"}:
                raise RuntimeError("Synthetic handoff failed")
            time.sleep(5 + random.random())
        return {
            "validation": ready_times,
            "handoff": time.monotonic() - submitted,
            "total": time.monotonic() - started,
        }


def percentile(values):
    return round(sorted(values)[max(0, int(len(values) * 0.95) - 1)], 3)


def main():
    participants = int(sys.argv[1]) if len(sys.argv) > 1 else 250
    if not 1 <= participants <= 250:
        raise SystemExit("Use 1 to 250 synthetic participants")
    # This fixed private service name has no production URL option. Its Compose
    # stack supplies a fresh database, local-only mail and synthetic demo event.
    with httpx.Client(base_url=BASE, verify=CONTEXT, timeout=10, trust_env=False) as client:
        for _ in range(60):
            try:
                if client.get("/-/readyz").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)
        else:
            raise SystemExit("Disposable stack did not become ready")
    started = time.monotonic()
    results, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=participants) as executor:
        futures = [executor.submit(participant, index) for index in range(participants)]
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:
                failures.append(type(exc).__name__)
    report = {
        "participants": participants,
        "completed": len(results),
        "failures": failures,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "scope": "Synthetic HTTP burst; two web workers, one 2-CPU/2-GB document worker; local mail and disabled malware scanner",
    }
    if results:
        report.update(
            p95_validation_seconds=percentile(
                [value for result in results for value in result["validation"]]
            ),
            p95_handoff_seconds=percentile([result["handoff"] for result in results]),
            p95_total_seconds=percentile([result["total"] for result in results]),
            median_total_seconds=round(statistics.median(result["total"] for result in results), 3),
        )
    print(json.dumps(report))
    if failures or report.get("p95_total_seconds", 901) > 900:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
