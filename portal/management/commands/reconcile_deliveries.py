import json

from django.core.management.base import BaseCommand, CommandError

from portal.services.evidence import reconcile


class Command(BaseCommand):
    help = "Reconcile the known message IDs of sent emails without resending. Unknown sends require manual provider lookup."

    def add_arguments(self, parser):
        parser.add_argument("--batch-size", type=int, default=100)

    def handle(self, *args, **options):
        if not 1 <= options["batch_size"] <= 1000:
            raise CommandError("batch-size must be between 1 and 1000")
        counts = reconcile(options["batch_size"])
        self.stdout.write(json.dumps(counts))
        if counts["failed"]:
            raise CommandError(f"Provider lookup failed for {counts['failed']} emails.")
