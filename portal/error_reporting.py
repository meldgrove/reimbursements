"""Error reports to Sentry with the same limits as the logs.

Off unless SENTRY_DSN is set. A report keeps the exception type, code locations,
the URL pattern and this application's own log message. It never contains
exception values, request data, users, local variables or breadcrumbs, which can
hold names, bank details, receipt text or file paths.
"""

import sys
from pathlib import Path

import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration
from sentry_sdk.integrations.logging import ignore_logger
from sentry_sdk.integrations.stdlib import StdlibIntegration

# Everything else in an event is removed, including request, user, extra and modules.
KEPT_FIELDS = {
    "environment",
    "event_id",
    "exception",
    "level",
    "logentry",
    "logger",
    "platform",
    "release",
    "sdk",
    "tags",
    "timestamp",
    "transaction",
    "transaction_info",
}
KEPT_EXCEPTION_FIELDS = {"module", "type"}
KEPT_MECHANISM_FIELDS = {"type", "handled", "exception_id", "parent_id", "is_exception_group"}
KEPT_FRAME_FIELDS = {
    "filename",
    "function",
    "in_app",
    "lineno",
    "module",
}
# The application's log messages carry only references such as job or claim IDs.
OWN_LOGGERS = ("portal", "config")


def redact(event, hint=None):
    """Keep diagnostic metadata and code locations without free-form SDK fields."""
    event = {key: value for key, value in event.items() if key in KEPT_FIELDS}
    if (event.get("transaction_info") or {}).get("source") != "route":
        # The SDK can use the raw request path when no Django route is available.
        event.pop("transaction", None)
        event.pop("transaction_info", None)
    else:
        event["transaction_info"] = {"source": "route"}

    if "tags" in event:
        event["tags"] = {key: value for key, value in event["tags"].items() if key == "process"}
    if exceptions := (event.get("exception") or {}).get("values"):
        safe_exceptions = []
        for exception in exceptions:
            safe_exception = {
                key: value for key, value in exception.items() if key in KEPT_EXCEPTION_FIELDS
            }
            if mechanism := exception.get("mechanism"):
                safe_exception["mechanism"] = {
                    key: value for key, value in mechanism.items() if key in KEPT_MECHANISM_FIELDS
                }
            frames = (exception.get("stacktrace") or {}).get("frames") or []
            if frames:
                safe_exception["stacktrace"] = {
                    "frames": [
                        {key: value for key, value in frame.items() if key in KEPT_FRAME_FIELDS}
                        for frame in frames
                    ]
                }
            safe_exceptions.append(safe_exception)
        event["exception"] = {"values": safe_exceptions}
    else:
        event.pop("exception", None)

    logger = str(event.get("logger", ""))
    if event.get("logentry") and logger.split(".", 1)[0] not in OWN_LOGGERS:
        # A library may interpolate data before it calls the logger.
        event["logentry"] = {"message": "Third-party log error"}
    return event


def process_name(argv):
    """`web` for the web server, otherwise the management command, e.g. `run_jobs`."""
    if len(argv) > 1 and Path(argv[0]).name == "manage.py":
        return argv[1]
    return "web"


def options(dsn, environment, release=None):
    return {
        "dsn": dsn,
        "environment": environment,
        "release": release or None,
        "integrations": [DjangoIntegration(transaction_style="url")],
        # Stdlib would add trace variables to document children, whose environment is
        # fixed. No trace headers on requests to MailerSend or Keycloak either.
        "disabled_integrations": [StdlibIntegration()],
        "trace_propagation_targets": [],
        # `redact` removes these again; not collecting them is the first line.
        "data_collection": {
            "user_info": False,
            "cookies": {"mode": "off"},
            "http_headers": {"request": {"mode": "off"}},
            "http_bodies": [],
            "url_query_params": {"mode": "off"},
            "database_query_data": False,
            "queues": False,
            "stack_frame_variables": False,
            "frame_context_lines": 0,
            "graphql": {"document": False, "variables": False},
            "gen_ai": {"inputs": False, "outputs": False},
        },
        "max_breadcrumbs": 0,
        "before_send": redact,
    }


def start(dsn, environment, release=None):
    # Django logs client mistakes such as an unknown Host header at ERROR, with the value.
    ignore_logger("django.security.*")
    sentry_sdk.init(**options(dsn, environment, release))
    sentry_sdk.get_global_scope().set_tag("process", process_name(sys.argv))
