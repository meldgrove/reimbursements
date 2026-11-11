from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from portal.models import Form, FormTemplate

DEMO_PURPOSES = [
    "Teilnahme an der Werkstatt zur Förderung des bürgerschaftlichen Engagements",
    "Mitwirkung als Referent:in in der Werkstatt",
]


class Command(BaseCommand):
    help = "Create the local demo form at /f/demo/. Local development only."

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.DEBUG or settings.MAIL_DELIVERY_MODE != "local":
            raise CommandError("Demo data is allowed only in local development.")
        template = FormTemplate.objects.filter(name="Externe Erstattung").first()
        if template is None:
            raise CommandError("Run migrations first; they create the default template.")
        form, created = Form.objects.get_or_create(
            slug="demo",
            defaults={
                "template": template,
                "name": "Demo-Veranstaltung",
                "field_values": {"kst": "DEMO", "ktr": "DEMO-2026", "id": "WS-1"},
                "purpose_options": "\n".join(DEMO_PURPOSES),
                "instructions": (
                    "Reiche hier deine Auslagen für die Werkstatt ein. Bitte füge für jede "
                    "Position alle zugehörigen Belegseiten hinzu."
                ),
                "recipient": "finance@example.invalid",
                "support_email": "finance@example.invalid",
                "status": Form.Status.PUBLISHED,
            },
        )
        self.stdout.write(f"{'Created' if created else 'Kept'} demo form at /f/{form.slug}/.")
