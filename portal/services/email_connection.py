"""The email connection: which provider sends the app's email, and as whom.

Admins set it up under Admin > Email (`EmailSettings`): MailerSend with an API token, or
an SMTP server. A value set in the environment wins over its field there:
MAILERSEND_API_TOKEN chooses MailerSend, and MAIL_FROM_ADDRESS, MAIL_REPLY_TO_ADDRESS and
MAILERSEND_WEBHOOK_SIGNING_SECRET each replace one field. With MAIL_DELIVERY_MODE=local,
in development, every email stays in a private outbox instead.

Forms take no claims until the connection is ready (`terms.refusal`).
"""

from dataclasses import dataclass

from django.conf import settings

from portal.models import EmailSettings

LOCAL, MAILERSEND, SMTP = "local", "mailersend", "smtp"
PROVIDER_NAMES = {LOCAL: "Local outbox", MAILERSEND: "MailerSend", SMTP: "SMTP server", "": ""}
# The admin's fields that an environment variable can replace.
ENVIRONMENT = {
    "from_address": "MAIL_FROM_ADDRESS",
    "reply_to_address": "MAIL_REPLY_TO_ADDRESS",
    "mailersend_token": "MAILERSEND_API_TOKEN",
    "webhook_secret": "MAILERSEND_WEBHOOK_SIGNING_SECRET",
}
SECRETS = ("mailersend_token", "webhook_secret", "smtp_password")

# What a send or a setup check that failed with this error code means for admins.
PROBLEMS = {
    "email_not_set_up": "Email is not set up yet. Choose a provider and save first.",
    "test_recipient_blocked": "TEST_RECIPIENT_ALLOWLIST does not include the recipient.",
    "unapproved_recipient": "APPROVED_DELIVERY_RECIPIENTS does not include the recipient.",
    "provider_connection": "MailerSend could not be reached. Try again in a minute.",
    "provider_throttled": "MailerSend limits requests right now. Try again in a minute.",
    "recipient_suppressed": "MailerSend suppresses this recipient after an earlier bounce.",
    "provider_outcome_unknown": "The provider gave no clear answer; the email may still arrive.",
    "provider_response_invalid": "MailerSend gave an answer the app does not understand.",
    "provider_message_id_missing": "MailerSend accepted the email without a message ID.",
    "recipient_rejected": "The SMTP server refused the recipient.",
    "smtp_connection": "The SMTP server could not be reached. Check the server, the port "
    "and the encryption.",
    "smtp_tls_failed": "The encrypted connection to the SMTP server failed. Check the "
    "encryption and the port, and that the server has a valid certificate.",
    "smtp_tls_unavailable": "The SMTP server does not offer STARTTLS. Choose TLS, or check "
    "the port.",
    "smtp_login_unavailable": "The SMTP server does not offer a login. Leave the username "
    "empty, or choose encryption: many servers only offer a login over an encrypted "
    "connection.",
    "smtp_login_failed": "The SMTP server refused the username or the password.",
    "smtp_login_not_ascii": "The SMTP login takes only ASCII characters in the username "
    "and the password.",
    "address_not_ascii": "SMTP takes only email addresses in ASCII characters.",
    "smtp_sender_refused": "The SMTP server refused the sender address.",
    "smtp_deferred": "The SMTP server deferred the email. Try again later.",
}
REJECTED = {
    MAILERSEND: "MailerSend refused the email. Check the API token and that "
    "the sender address is on a verified MailerSend domain.",
    SMTP: "The SMTP server refused the email.",
}


def problem(error_code, provider):
    """What `error_code` of a send with `provider` means, for admins."""
    if error_code == "provider_rejected" and provider in REJECTED:
        return REJECTED[provider]
    return PROBLEMS.get(error_code, f"Sending failed ({error_code}).")


def environment(name):
    """The environment's value for the admin field `name`, or "" when it sets none."""
    return getattr(settings, ENVIRONMENT[name], "") if name in ENVIRONMENT else ""


def local():
    """Development keeps every email in a private outbox."""
    return settings.MAIL_DELIVERY_MODE == "local" and settings.DEBUG


@dataclass(frozen=True)
class SmtpAccount:
    host: str
    port: int
    security: str
    username: str
    password: str


@dataclass(frozen=True)
class Connection:
    # LOCAL, MAILERSEND or SMTP; "" while no provider is chosen.
    provider: str
    sender: str
    reply_to: str
    # Saved credentials, also while another provider sends: MailerSend's evidence about
    # emails it sent earlier still needs them.
    mailersend_token: str
    webhook_secret: str
    smtp: SmtpAccount
    # Saved secrets the current DJANGO_SECRET_KEY cannot open; they count as missing.
    unreadable: tuple[str, ...] = ()

    @property
    def name(self):
        return PROVIDER_NAMES[self.provider]

    @property
    def missing(self):
        """What the connection needs before it can send, as the admin's field labels."""
        missing = []
        if not self.provider:
            missing.append("a provider")
        if not self.sender:
            missing.append("a sender address")
        if not self.reply_to:
            missing.append("a reply address for Finance")
        if self.provider == MAILERSEND and not self.mailersend_token:
            missing.append("a MailerSend API token")
        if self.provider == SMTP:
            if not self.smtp.host:
                missing.append("an SMTP server")
            if self.smtp.username and not self.smtp.password:
                missing.append("an SMTP password")
        return missing

    @property
    def ready(self):
        return not self.missing


def current(saved=None):
    """The connection the app sends with now; `saved` defaults to the saved settings."""
    saved = saved if saved is not None else EmailSettings.load()
    secrets, unreadable = {}, []
    for name in SECRETS:
        value = environment(name) or saved.secret(name)
        if value is None:
            unreadable.append(name)
        secrets[name] = value or ""
    if local():
        provider = LOCAL
    elif environment("mailersend_token"):
        provider = MAILERSEND
    else:
        provider = saved.provider
    return Connection(
        provider=provider,
        sender=environment("from_address") or saved.from_address,
        reply_to=environment("reply_to_address") or saved.reply_to_address,
        mailersend_token=secrets["mailersend_token"],
        webhook_secret=secrets["webhook_secret"],
        smtp=SmtpAccount(
            host=saved.smtp_host,
            port=saved.smtp_port,
            security=saved.smtp_security,
            username=saved.smtp_username,
            password=secrets["smtp_password"],
        ),
        unreadable=tuple(unreadable),
    )


def ready():
    """Whether the app can send email now, so forms may take claims."""
    return current().ready
