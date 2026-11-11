"""An explicit development configuration for the isolated test runner."""

import os

os.environ.setdefault("DJANGO_DEBUG", "1")
os.environ.setdefault("DEPLOYMENT_ENV", "development")

from .settings import *  # noqa: E402,F403
