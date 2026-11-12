import json

from django.core.management.base import BaseCommand

from portal.models import Claim, Job
from portal.services import claim_status, queue
from portal.services.readiness import queue_age_seconds


class Command(BaseCommand):
    help = "Inspect operational state without printing addresses or banking details."

    def add_arguments(self, parser):
        parser.add_argument("reference", nargs="?")
        parser.add_argument(
            "--status",
            choices=[code for code, _label in claim_status.CHOICES],
            help="The status the admin list shows.",
        )
        parser.add_argument("--state", choices=Claim.State.values)
        parser.add_argument("--delivery-state")

    def handle(self, *args, **options):
        claims = claim_status.annotate(
            Claim.objects.select_related("delivery").order_by("submitted_at", "pk")
        )
        if options["reference"]:
            claims = claims.for_reference(options["reference"])
        if options["status"]:
            claims = claims.filter(status=options["status"])
        if options["state"]:
            claims = claims.filter(state=options["state"])
        if options["delivery_state"]:
            claims = claims.filter(delivery__state=options["delivery_state"])
        for claim in claims.iterator(chunk_size=100):
            current = getattr(claim, "delivery", None)
            status = claim_status.of(claim)
            self.stdout.write(
                json.dumps(
                    {
                        "reference": claim.reference,
                        "status": status.code,
                        "state": claim.state,
                        "submitted_at": claim.submitted_at.isoformat(),
                        "delivery_state": current.state if current else None,
                        "error_code": status.error_code,
                        "resolution_overdue": status.overdue,
                        "archived": status.archived,
                    }
                )
            )
        age = queue_age_seconds()
        self.stdout.write(
            json.dumps(
                {
                    "pending_jobs": Job.objects.filter(state=queue.PENDING).count(),
                    "failed_jobs": Job.objects.filter(state=queue.FAILED).count(),
                    "oldest_job_age_seconds": age,
                }
            )
        )
