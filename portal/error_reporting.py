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

# Everything else in an event is removed, including request, user, extra and modules.
KEPT_FIELDS = {
    "contexts",
    "environment",
    "event_id",
    "exception",
    "fingerprint",
    "level",
    "logentry",
    "logger",
    "platform",
    "release",
    "sdk",
    "server_name",
    "tags",
    "timestamp",
    "transaction",
    "transaction_info",
}
KEPT_CONTEXTS = {"os", "runtime", "trace"}
KEPT_FRAME_FIELDS = {
    "abs_path",
    "context_line",
    "filename",
    "function",
    "in_app",
    "lineno",
    "module",
    "post_context",
    "pre_context",
}
# The application's log messages carry only references such as job or claim IDs.
OWN_LOGGERS = ("portal", "config")


def redact(event, hint=None):
    """`before_send`: keep an allowlist of fields; drop exception values and frame locals."""
    event = {key: value for key, value in event.items() if key in KEPT_FIELDS}
    if "contexts" in event:
        event["contexts"] = {
            key: value for key, value in event["contexts"].items() if key in KEPT_CONTEXTS
        }
    for exception in (event.get("exception") or {}).get("values") or []:
        exception.pop("value", None)
        for frame in (exception.get("stacktrace") or {}).get("frames") or []:
            for key in set(frame) - KEPT_FRAME_FIELDS:
                del frame[key]
    logentry = event.get("logentry")
    if logentry and not str(event.get("logger", "")).startswith(OWN_LOGGERS):
        # Library messages can include document text or file names: keep the template only.
        event["logentry"] = {"message": logentry.get("message")}
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
