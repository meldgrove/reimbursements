from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email

from portal.services import outbound, setup_check


class Command(BaseCommand):
    help = (
        "Check this installation end to end: storage, worker, document sandbox, malware "
        "scanner and Keycloak, then one synthetic claim to an approved Finance inbox, which "
        "is deleted again. See portal/services/setup_check.py."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--to",
            required=True,
            help="The Finance inbox for the test claim's PDF; one of APPROVED_DELIVERY_RECIPIENTS.",
        )
        parser.add_argument(
            "--confirmation-to",
            help="Where the participant confirmation goes. Defaults to --to.",
        )
        parser.add_argument(
            "--timeout",
            type=int,
            default=300,
            help="Seconds to wait for the worker and MailerSend. Default: 300.",
        )

    def handle(self, *args, **options):
        finance = options["to"].strip().lower()
        participant = (options["confirmation_to"] or finance).strip().lower()
        for address in {finance, participant}:
            try:
                validate_email(address)
            except ValidationError as exc:
                raise CommandError(f"{address!r} is not an email address.") from exc
        if not outbound.recipient_approved(finance):
            raise CommandError(
                f"{finance} is not in APPROVED_DELIVERY_RECIPIENTS. Use an approved Finance inbox."
            )
        allowlist = settings.TEST_RECIPIENT_ALLOWLIST
        if blocked := sorted(a for a in {finance, participant} if allowlist and a not in allowlist):
            raise CommandError(f"TEST_RECIPIENT_ALLOWLIST does not include {', '.join(blocked)}.")
        if options["timeout"] < 1:
            raise CommandError("--timeout must be at least 1 second.")
        self.stdout.write(
            f"Setup check ({settings.DEPLOYMENT_ENV}, email by {settings.MAIL_DELIVERY_MODE})"
        )
        check = setup_check.SetupCheck(
            finance=finance, participant=participant, timeout=options["timeout"], report=self.line
        )
        if not check.run():
            problems = f"{check.failures} problem{'s' if check.failures != 1 else ''}"
            raise CommandError(f"Setup check failed: {problems}.")
        self.stdout.write(self.style.SUCCESS("Setup check passed."))

    def line(self, status, title, detail=""):
        style = {
            setup_check.OK: self.style.SUCCESS,
            setup_check.FAIL: self.style.ERROR,
            setup_check.SKIP: self.style.WARNING,
        }[status]
        self.stdout.write(f"  {style(status.ljust(4))}  {title}")
        if detail:
            self.stdout.write(f"        {detail}")
