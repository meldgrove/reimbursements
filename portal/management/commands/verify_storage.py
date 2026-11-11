"""Read-only consistency check for release and isolated restore verification."""

import json

from django.core.management.base import BaseCommand, CommandError

from portal.models import Claim, Upload
from portal.services.storage import verify


class Command(BaseCommand):
    help = "Verify database/file consistency without printing participant data."

    def handle(self, *args, **options):
        checked, failures = 0, 0
        for upload in Upload.objects.all().iterator(chunk_size=100):
            checks = [(upload.source_key, upload.size, upload.checksum)]
            if upload.normalized_key and upload.normalized_key != upload.source_key:
                checks.append((upload.normalized_key, upload.normalized_size, None))
            for key, size, checksum in checks:
                checked += 1
                failures += not verify(key, size=size, checksum=checksum)
        for claim in Claim.objects.exclude(pdf_key="").iterator(chunk_size=100):
            checked += 1
            failures += not verify(claim.pdf_key, size=claim.pdf_size, checksum=claim.pdf_hash)
        self.stdout.write(json.dumps({"files_checked": checked, "failures": failures}))
        if failures:
            raise CommandError("Private storage verification failed.")
