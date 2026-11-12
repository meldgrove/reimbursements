import json

from django.core.management.base import BaseCommand

from portal.services.retention import cleanup


class Command(BaseCommand):
    help = (
        "Preview due deletions, or execute them with --execute. Unresolved claims "
        "require human resolution unless archived."
    )

    def add_arguments(self, parser):
        parser.add_argument("--execute", action="store_true")

    def handle(self, *args, **options):
        self.stdout.write(json.dumps(cleanup(execute=options["execute"])))
