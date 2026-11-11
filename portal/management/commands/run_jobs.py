import json
import logging
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from portal.jobs import reclaim_stale_jobs, run_one
from portal.services.delivery import reconcile_unmatched
from portal.services.retention import cleanup
from portal.services.storage import write_heartbeat


class Command(BaseCommand):
    help = "Run the single MVP worker, including periodic recovery and deletion."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--drain", action="store_true")

    def handle(self, *args, **options):
        last_maintenance = 0
        try:
            while True:
                close_old_connections()
                if time.monotonic() - last_maintenance > 60:
                    reclaim_stale_jobs()
                    reconcile_unmatched()
                    result = cleanup(execute=True)
                    if result["failures"] or result["unresolved_near_expiry"]:
                        logging.getLogger(__name__).warning(
                            "maintenance_attention %s", json.dumps(result)
                        )
                    last_maintenance = time.monotonic()
                write_heartbeat()
                processed = run_one()
                if options["once"] or (options["drain"] and not processed):
                    return
                if not processed:
                    time.sleep(1)
        except KeyboardInterrupt:
            return
