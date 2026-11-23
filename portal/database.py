"""A lost database connection, and the worker's wait until PostgreSQL is back.

PostgreSQL restarts during updates. Until it accepts connections again, every query
fails. The worker treats that as an outage: it closes its connections, logs a warning
and tries again with backoff. Only an outage that outlasts REPORT_AFTER_SECONDS is an
error. Every other database error is a real one and stays an error.
"""

import logging
import time

import psycopg
from django.db import OperationalError, connections

logger = logging.getLogger(__name__)

# The server ended or refused the session because it shuts down, crashed or still starts
# up. Class 08 is every connection exception.
LOST_SQLSTATES = frozenset({"57P01", "57P02", "57P03"})
FIRST_WAIT_SECONDS = 1
LONGEST_WAIT_SECONDS = 30
# A restart during an update takes seconds; recovery after a crash can take a minute or
# two. Five minutes is longer than both and well before the worker's heartbeat check
# (420 seconds) marks the worker unhealthy, so the error names the cause first.
REPORT_AFTER_SECONDS = 5 * 60


def connection_lost(exc):
    """Whether a database error means the connection is gone, not that a query failed.

    psycopg 3 raises OperationalError without a SQLSTATE when the server sent no error:
    a refused, reset or closed connection, or an unknown host while the database's
    container is replaced. Its InterfaceError means misuse, such as a closed cursor, and
    stays a real error, as do SQLite's errors.
    """
    if not isinstance(exc, OperationalError):
        return False
    cause = exc.__cause__
    if not isinstance(cause, psycopg.OperationalError):
        return False
    sqlstate = cause.sqlstate
    return sqlstate is None or sqlstate.startswith("08") or sqlstate in LOST_SQLSTATES


class Outage:
    """Backoff and reporting while the database is unreachable."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.started = None
        self.wait = FIRST_WAIT_SECONDS
        self.reported = False

    def lost(self, exc):
        """Close the lost connections and log. Returns the seconds to wait before retrying."""
        connections.close_all()
        now = self.clock()
        if self.started is None:
            self.started = now
        seconds, error = int(now - self.started), type(exc.__cause__ or exc).__name__
        if seconds >= REPORT_AFTER_SECONDS and not self.reported:
            self.reported = True
            logger.error("database_unreachable seconds=%d error=%s", seconds, error)
        else:
            logger.warning(
                "database_unavailable seconds=%d error=%s retry_in=%d", seconds, error, self.wait
            )
        wait, self.wait = self.wait, min(self.wait * 2, LONGEST_WAIT_SECONDS)
        return wait

    def ended(self):
        """The database answered again."""
        if self.started is None:
            return
        logger.info("database_available seconds=%d", int(self.clock() - self.started))
        self.started, self.wait, self.reported = None, FIRST_WAIT_SECONDS, False
