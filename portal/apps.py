from django.apps import AppConfig


class PortalConfig(AppConfig):
    name = "portal"

    def ready(self):
        from django.conf import settings
        from django.core.exceptions import ImproperlyConfigured

        from portal import checks

        if not settings.DEBUG:
            errors = checks.production_checks(None)
            if errors:
                raise ImproperlyConfigured(" ".join(error.msg for error in errors))
