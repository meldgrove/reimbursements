"""SMTP: the transport adapter for an SMTP server set up under Admin > Email.

The server's acceptance of a message is the last thing the app learns about it: SMTP
reports neither delivery nor bounces back to the app, and bounces go to the sender
address. So an accepted message counts as delivered, and nothing is reconciled later.

Every failure before the message content is sent is definite and retried later, as with
any provider that refuses before acceptance. A failure while sending the content leaves
the outcome unknown, because the server may have accepted the message.
"""

import contextlib
import smtplib
import ssl
from email import policy
from email.headerregistry import Address
from email.utils import formatdate, make_msgid

from portal.constants import APP_NAME
from portal.models import EmailSettings
from portal.services.transport import DELIVERED, FAILED, PENDING, UNKNOWN, SendResult, mime

TIMEOUT_SECONDS = 30
# Seven-bit content and CRLF line ends, which every SMTP server accepts.
SMTP_POLICY = policy.SMTP.clone(cte_type="7bit")


class Refused(Exception):
    """The server refused before the message content was sent. Holds the error code."""

    def __init__(self, code, retry_after=60):
        super().__init__(code)
        self.code, self.retry_after = code, retry_after


def connect(account, timeout=TIMEOUT_SECONDS):
    """A connection to `account`'s server, encrypted as set up and signed in.

    Raises Refused when that fails.
    """
    context = ssl.create_default_context()
    server = None
    try:
        if account.security == EmailSettings.Security.TLS:
            server = smtplib.SMTP_SSL(account.host, account.port, timeout=timeout, context=context)
        else:
            server = smtplib.SMTP(account.host, account.port, timeout=timeout)
        server.ehlo()
        if account.security == EmailSettings.Security.STARTTLS:
            if not server.has_extn("starttls"):
                raise Refused("smtp_tls_unavailable", 900)
            server.starttls(context=context)
            server.ehlo()
        if account.username:
            if not server.has_extn("auth"):
                raise Refused("smtp_login_unavailable", 900)
            server.login(account.username, account.password)
        return server
    except (Refused, OSError) as exc:
        if server is not None:
            close(server)
        if isinstance(exc, Refused):
            raise
        if isinstance(exc, smtplib.SMTPAuthenticationError):
            raise Refused("smtp_login_failed", 900) from exc
        if isinstance(exc, ssl.SSLError):
            raise Refused("smtp_tls_failed", 900) from exc
        raise Refused("smtp_connection") from exc


def close(server):
    with contextlib.suppress(OSError):
        server.quit()
    with contextlib.suppress(OSError):
        server.close()


def _refusal(code):
    """The result of a refusal with SMTP reply `code`: 5xx is permanent, 4xx temporary."""
    if code >= 500:
        return SendResult(FAILED, error_code="provider_rejected")
    return SendResult(PENDING, error_code="smtp_deferred", retry_after=300)


class SmtpTransport:
    """Deployment transport: an SMTP server."""

    def __init__(self, account, timeout=TIMEOUT_SECONDS):
        self.account, self.timeout = account, timeout

    def send(self, message):
        email = mime(
            message,
            sender=Address(display_name=APP_NAME, addr_spec=message.sender),
            email_policy=SMTP_POLICY,
        )
        email["Date"] = formatdate(usegmt=True)
        email["Message-ID"] = make_msgid(domain=message.sender.rpartition("@")[2] or None)
        try:
            server = connect(self.account, self.timeout)
        except Refused as exc:
            return SendResult(PENDING, error_code=exc.code, retry_after=exc.retry_after)
        try:
            return self._transmit(server, message, email.as_bytes())
        finally:
            close(server)

    def _transmit(self, server, message, content):
        try:
            code, _ = server.mail(message.sender)
            if code != 250:
                return SendResult(PENDING, error_code="smtp_sender_refused", retry_after=900)
            code, _ = server.rcpt(message.recipient)
            if code not in {250, 251}:
                if code >= 500:
                    return SendResult(FAILED, error_code="recipient_rejected")
                return _refusal(code)
        except OSError:
            return SendResult(PENDING, error_code="smtp_connection", retry_after=60)
        try:
            code, _ = server.data(content)
        except smtplib.SMTPDataError as exc:
            # The server refused DATA itself, before the content was sent.
            return _refusal(exc.smtp_code)
        except OSError:
            return SendResult(UNKNOWN, error_code="provider_outcome_unknown")
        if code != 250:
            return _refusal(code)
        return SendResult(DELIVERED, f"smtp-{message.attempt_id}")
