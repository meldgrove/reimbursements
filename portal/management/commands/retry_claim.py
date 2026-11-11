import getpass

from django.core.management.base import BaseCommand, CommandError

from portal.services import operations

MESSAGES = {
    "active_job": "This claim already has an active job.",
    "duplicate_risk": (
        "Check provider activity first. Use --acknowledge-duplicate-risk for an intentional resend."
    ),
    "not_retryable": "This claim cannot be retried in its current state.",
    "pdf_removed": "The PDF of this claim was already deleted.",
}


class Command(BaseCommand):
    help = "Retry a failed render/send. Ambiguous or accepted sends require explicit duplicate-risk acknowledgment."

    def add_arguments(self, parser):
        parser.add_argument("reference")
        parser.add_argument("--reason", required=True)
        parser.add_argument("--actor", default=getpass.getuser())
        parser.add_argument("--acknowledge-duplicate-risk", action="store_true")

    def handle(self, *args, **options):
        try:
            claim = operations.retry(
                options["reference"],
                actor=options["actor"],
                reason=options["reason"],
                acknowledge_duplicate_risk=options["acknowledge_duplicate_risk"],
            )
        except operations.ActionRefused as exc:
            raise CommandError(MESSAGES.get(exc.code, str(exc))) from exc
        self.stdout.write(f"Queued retry for {claim.reference}.")
