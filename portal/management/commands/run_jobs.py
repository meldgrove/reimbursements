import json
import logging
import time

from django.core.management.base import BaseCommand
from django.db import DatabaseError, close_old_connections

from portal import database
from portal.jobs import Interrupted, reclaim_stale_jobs, run_one
from portal.services.evidence import reconcile_unmatched
from portal.services.retention import cleanup
from portal.services.storage import write_heartbeat


class Command(BaseCommand):
    help = "Run the single MVP worker, including periodic recovery and deletion."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--drain", action="store_true")

    def handle(self, *args, **options):
        """Work until stopped. A lost database connection waits with backoff instead of
        ending the worker (`portal.database`)."""
        self.last_maintenance = 0
        outage, abandoned = database.Outage(), None
        try:
            while True:
                try:
                    close_old_connections()
                    if abandoned:
                        abandoned.abandon()
                        abandoned = None
                    processed = self.work()
                except Interrupted as interruption:
                    abandoned = interruption.lease
                    time.sleep(outage.lost(interruption.__cause__))
                    continue
                except DatabaseError as exc:
                    if not database.connection_lost(exc):
                        raise
                    time.sleep(outage.lost(exc))
                    continue
                outage.ended()
                if options["once"] or (options["drain"] and not processed):
                    return
                if not processed:
                    time.sleep(1)
        except KeyboardInterrupt:
            return

    def work(self):
        """Maintenance once a minute, the heartbeat, then the next due job."""
        if time.monotonic() - self.last_maintenance > 60:
            reclaim_stale_jobs()
            reconcile_unmatched()
            result = cleanup(execute=True)
            if result["failures"] or result["unresolved_near_expiry"]:
                logging.getLogger(__name__).warning("maintenance_attention %s", json.dumps(result))
            self.last_maintenance = time.monotonic()
        write_heartbeat()
        return run_one()
