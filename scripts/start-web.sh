#!/bin/sh
set -eu

exec gunicorn config.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers "${TOTAL_WEB_WORKERS:-2}" \
    --timeout 90 \
    --access-logfile - \
    --access-logformat 'request=%({x-request-id}o)s method=%(m)s status=%(s)s duration=%(L)s' \
    "$@"
