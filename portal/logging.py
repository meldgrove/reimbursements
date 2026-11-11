"""Operational diagnostics without request bodies, exception values or locals."""

import logging
import traceback
from pathlib import Path


class RedactedExceptionFormatter(logging.Formatter):
    def formatException(self, exc_info):
        frames = traceback.extract_tb(exc_info[2])
        stack = "\n".join(
            f"  {Path(frame.filename).name}:{frame.lineno} in {frame.name}" for frame in frames
        )
        return f"{exc_info[0].__name__}\n{stack}"


class SafeRequestFilter(logging.Filter):
    def filter(self, record):
        request = getattr(record, "request", None)
        match = getattr(request, "resolver_match", None)
        record.msg = "http_failure request=%s status=%s route=%s"
        record.args = (
            getattr(request, "request_id", "unavailable"),
            getattr(record, "status_code", 500),
            getattr(match, "url_name", None) or "unmatched",
        )
        record.request = None
        return True
