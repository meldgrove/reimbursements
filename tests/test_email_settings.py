"""Admin > Email: the provider and its credentials, the confirmation, and the SMTP adapter."""

import base64
import hashlib
import hmac
import json
import re
import smtplib
import socketserver
import threading
import uuid
from email import message_from_bytes, policy

import pytest
from django.utils import timezone

from portal import encryption, roles
from portal.jobs import run_one
from portal.models import Confirmation, Delivery, DeliveryAttempt, EmailSettings, Job
from portal.services import confirmations, email_connection, evidence, outbound, queue, smtp
from portal.services import delivery as deliveries
from portal.services.transport import DELIVERED, FAILED, PENDING, UNKNOWN, Message, NotSetUp
from tests.test_general_settings import signed_in

pytestmark = pytest.mark.django_db

URL = "/admin/portal/emailsettings/1/change/"
TEST_URL = "/admin/portal/emailsettings/test/"


@pytest.fixture
def admin_client(client):
    return signed_in(client, roles.TEMPLATE_ADMIN)


@pytest.fixture
def unset(settings):
    """A deployment that sends email and sets none of it in the environment."""
    settings.MAIL_DELIVERY_MODE = "send"
    settings.MAILERSEND_API_TOKEN = ""
    settings.MAILERSEND_WEBHOOK_SIGNING_SECRET = ""
    settings.MAIL_FROM_ADDRESS = ""
    settings.MAIL_REPLY_TO_ADDRESS = ""


def email_form(**changes):
    data = {
        "provider": "",
        "from_address": "",
        "reply_to_address": "",
        "smtp_host": "",
        "smtp_port": "587",
        "smtp_security": "starttls",
        "smtp_username": "",
        "confirmation_enabled": "on",
    }
    for code in ("de", "en"):
        subject, body = confirmations.standard_texts(code)
        data[f"confirmation_subject_{code}"] = subject
        # Browsers send line breaks as CRLF.
        data[f"confirmation_body_{code}"] = body.replace("\n", "\r\n")
    data.update(changes)
    return {key: value for key, value in data.items() if value is not None}


SENDER = {"from_address": "no-reply@example.invalid", "reply_to_address": "finance@example.invalid"}


def mailersend_form(**changes):
    return email_form(**{"provider": "mailersend", **SENDER, **changes})


def smtp_form(**changes):
    return email_form(**{"provider": "smtp", **SENDER, "smtp_host": "127.0.0.1", **changes})


def errors(response):
    return re.findall(
        r'<ul class="errorlist[^"]*"[^>]*>\s*<li>(.*?)</li>', response.content.decode()
    )


# Encryption


def test_secrets_open_only_with_the_secret_key_or_its_fallbacks(settings):
    sealed = encryption.seal("mlsn.synthetic-token")
    assert "synthetic" not in sealed and encryption.unseal(sealed) == "mlsn.synthetic-token"
    assert encryption.seal("") == "" and encryption.unseal("") == ""
    old_key = settings.SECRET_KEY
    settings.SECRET_KEY = "another-secret-key-" * 4
    assert encryption.unseal(sealed) is None
    settings.SECRET_KEY_FALLBACKS = [old_key]
    assert encryption.unseal(sealed) == "mlsn.synthetic-token"


# The connection


def test_without_settings_nothing_can_send_and_forms_refuse_claims(unset, form, client):
    connection = email_connection.current()
    assert connection.provider == "" and not connection.ready
    assert connection.missing == ["a provider", "a sender address", "a reply address for Finance"]
    assert isinstance(outbound.configured_transport(), NotSetUp)
    response = client.get(f"/f/{form.slug}/")
    assert response.status_code == 503
    assert "Das Formular ist derzeit nicht verfügbar." in response.content.decode()


def test_the_environment_wins_over_the_admin_settings(unset, settings):
    saved = EmailSettings(provider="smtp", smtp_host="smtp.example.invalid")
    saved.from_address, saved.reply_to_address = "admin@example.invalid", "reply@example.invalid"
    saved.set_secret("mailersend_token", "saved-token")
    saved.save()
    connection = email_connection.current()
    assert (connection.provider, connection.sender, connection.mailersend_token) == (
        "smtp",
        "admin@example.invalid",
        "saved-token",
    )
    settings.MAILERSEND_API_TOKEN = "environment-token"
    settings.MAIL_FROM_ADDRESS = "env@example.invalid"
    connection = email_connection.current()
    assert (connection.provider, connection.sender, connection.reply_to) == (
        "mailersend",
        "env@example.invalid",
        "reply@example.invalid",
    )
    assert connection.mailersend_token == "environment-token" and connection.ready


def test_a_secret_the_secret_key_cannot_open_counts_as_missing(unset, settings):
    saved = EmailSettings(provider="mailersend", from_address="a@example.invalid")
    saved.reply_to_address = "b@example.invalid"
    saved.set_secret("mailersend_token", "saved-token")
    saved.save()
    assert email_connection.ready()
    settings.SECRET_KEY = "a-new-secret-key-" * 4
    connection = email_connection.current()
    assert connection.unreadable == ("mailersend_token",) and not connection.ready
    assert connection.missing == ["a MailerSend API token"]


# The admin page


def test_only_template_admins_open_the_email_settings(client):
    signed_in(client, roles.FORM_EDITOR)
    assert client.get(URL).status_code == 403
    assert client.post(URL, mailersend_form()).status_code == 403
    assert client.post(TEST_URL, {"to": "kim@example.invalid"}).status_code == 403


def test_admins_enter_a_mailersend_token_that_is_never_shown_again(unset, admin_client):
    page = admin_client.get(URL).content.decode()
    assert "Not set up" in page and "Forms take no claims until email is set up" in page
    response = admin_client.post(
        URL, mailersend_form(mailersend_token="mlsn.synthetic-token", webhook_secret="whsec")
    )
    assert response.status_code == 302 and response.url == URL
    saved = EmailSettings.load()
    assert saved.secret("mailersend_token") == "mlsn.synthetic-token"
    assert "mlsn" not in saved.mailersend_token_sealed
    assert saved.secret("webhook_secret") == "whsec"
    page = admin_client.get(URL).content.decode()
    assert "mlsn.synthetic-token" not in page and "whsec" not in page
    assert "Saved · type a new one to replace it" in page
    assert "Sends with MailerSend from no-reply@example.invalid." in page
    # An empty field keeps the saved token; a new one replaces it.
    assert admin_client.post(URL, mailersend_form()).status_code == 302
    assert EmailSettings.load().secret("mailersend_token") == "mlsn.synthetic-token"
    admin_client.post(URL, mailersend_form(mailersend_token="mlsn.new"))
    assert EmailSettings.load().secret("mailersend_token") == "mlsn.new"
    # Deleting the webhook secret keeps the token.
    admin_client.post(URL, mailersend_form(delete_webhook_secret="on"))
    saved = EmailSettings.load()
    assert saved.secret("webhook_secret") == "" and saved.secret("mailersend_token") == "mlsn.new"


@pytest.mark.parametrize(
    ("data", "field_errors"),
    [
        (mailersend_form(), ["Enter the MailerSend API token."]),
        (
            email_form(provider="mailersend", mailersend_token="t"),
            ["Enter the address every email comes from.", "Enter where Finance&#x27;s replies go."],
        ),
        (smtp_form(smtp_host=""), ["Enter the SMTP server."]),
        (
            smtp_form(smtp_host="smtp example"),
            ["Enter a host name such as smtp.example.org, or an IP address."],
        ),
        (smtp_form(smtp_username="kim"), ["Enter the password for this username."]),
        (smtp_form(smtp_port="70000"), ["Ensure this value is less than or equal to 65535."]),
        (
            mailersend_form(confirmation_subject_de="Eingang {referenz}", mailersend_token="t"),
            [
                "{referenz} is not a placeholder. Use {name}, {form}, {reference}, "
                "{payment_timing}, {support}, {app_name}."
            ],
        ),
        (
            mailersend_form(confirmation_body_en="Hi {name!r}", mailersend_token="t"),
            ["Write the placeholder as {name}, without “:” or “!”."],
        ),
        (
            mailersend_form(confirmation_body_en="Hi } there", mailersend_token="t"),
            ["Write a single brace as {{ or }}; braces otherwise enclose a placeholder."],
        ),
    ],
)
def test_the_chosen_provider_needs_its_settings(unset, admin_client, data, field_errors):
    response = admin_client.post(URL, data)
    assert response.status_code == 200
    assert errors(response) == field_errors
    assert not EmailSettings.objects.exists()


def test_entering_and_deleting_a_secret_at_once_is_refused(unset, admin_client):
    admin_client.post(URL, smtp_form(smtp_username="kim", smtp_password="first"))
    response = admin_client.post(
        URL, smtp_form(smtp_username="kim", smtp_password="second", delete_smtp_password="on")
    )
    assert errors(response) == ["Delete it or enter a new one, not both."]
    assert EmailSettings.load().secret("smtp_password") == "first"


def test_settings_from_the_environment_are_shown_but_not_changed(unset, admin_client, settings):
    settings.MAILERSEND_API_TOKEN = "environment-token"
    settings.MAIL_FROM_ADDRESS = "env@example.invalid"
    page = admin_client.get(URL).content.decode()
    assert "Set by MAIL_FROM_ADDRESS in the environment." in page
    assert "MAILERSEND_API_TOKEN in the environment chooses MailerSend." in page
    assert 'value="env@example.invalid"' in page and "environment-token" not in page
    response = admin_client.post(
        URL,
        smtp_form(
            from_address="other@example.invalid",
            mailersend_token="ignored",
            reply_to_address="reply@example.invalid",
        ),
    )
    assert response.status_code == 302, errors(response)
    saved = EmailSettings.load()
    # The environment's values stay out of the database.
    assert (saved.provider, saved.from_address, saved.secret("mailersend_token")) == ("", "", "")
    assert saved.reply_to_address == "reply@example.invalid"
    connection = email_connection.current()
    assert (connection.provider, connection.sender) == ("mailersend", "env@example.invalid")


def test_unchanged_standard_texts_are_not_saved(admin_client):
    assert admin_client.post(URL, email_form()).status_code == 302
    assert EmailSettings.load().confirmation_texts == {}
    admin_client.post(
        URL, email_form(confirmation_subject_en="  Got   it: {reference} ", confirmation_body_de="")
    )
    assert EmailSettings.load().confirmation_texts == {"en": {"subject": "Got it: {reference}"}}
    page = admin_client.get(URL).content.decode()
    assert 'value="Got it: {reference}"' in page
    # An emptied field shows the standard text again.
    assert "Hallo {name}," in page


# The confirmation


def test_admins_write_their_own_confirmation(accepted, settings):
    saved = EmailSettings.load()
    saved.confirmation_texts = {
        "de": {
            "subject": "Eingang {reference}",
            "body": "Liebe*r {name}, danke für {form}. Fragen an {support}. {{Klammern}}\n",
        }
    }
    saved.save()
    confirmation = Confirmation.objects.get(claim=accepted)
    message = confirmations.compose(confirmation)
    assert message.subject == f"Eingang {accepted.reference}"
    assert message.text == (
        "Liebe*r Alex Beispiel, danke für Test Workshop. Fragen an finance@example.invalid. "
        "{Klammern}\n"
    )
    # English claims keep the standard text.
    accepted.snapshot["language"] = "en"
    accepted.save()
    message = confirmations.compose(Confirmation.objects.get(claim=accepted))
    assert message.subject.startswith("Confirmation of receipt: reimbursement claim")


def test_turned_off_confirmations_are_not_sent(prepared):
    EmailSettings(confirmation_enabled=False).save()
    page = prepared["client"].get("/f/test/").content.decode()
    assert "Für Rückfragen zu deinem Antrag." in page and "Eingangsbestätigung und" not in page
    response = prepared["client"].post(
        "/f/test/submit/", data=json.dumps(prepared["data"]), content_type="application/json"
    )
    assert response.status_code == 202
    assert not Confirmation.objects.exists()
    assert not Job.objects.filter(kind="confirm").exists()


# Sending without a provider


def test_without_a_provider_an_email_waits_and_retries(delivery, unset):
    attempt = DeliveryAttempt.objects.create(delivery=delivery)
    result = outbound.send(deliveries.compose, attempt)
    assert (result.state, result.error_code, result.retry_after) == (
        PENDING,
        "email_not_set_up",
        900,
    )


# SMTP


class SmtpHandler(socketserver.StreamRequestHandler):
    """Enough SMTP for smtplib: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, RSET and QUIT."""

    def reply(self, line):
        self.wfile.write(line.encode() + b"\r\n")

    def handle(self):
        server = self.server
        self.reply("220 fake.example.invalid ESMTP")
        while line := self.rfile.readline():
            command = line.decode().rstrip("\r\n")
            verb = command.split(" ", 1)[0].upper()
            server.commands.append(verb)
            if verb == "EHLO":
                if server.credentials:
                    self.reply("250-fake.example.invalid")
                    self.reply("250 AUTH PLAIN")
                else:
                    self.reply("250 fake.example.invalid")
            elif verb == "AUTH":
                _, user, password = base64.b64decode(command.split()[2]).split(b"\0")
                ok = (user.decode(), password.decode()) == server.credentials
                self.reply("235 Authenticated" if ok else "535 Authentication failed")
            elif verb == "MAIL":
                server.envelope["from"] = command
                self.reply("250 OK")
            elif verb == "RCPT":
                server.envelope["to"] = command
                self.reply(server.rcpt_reply)
            elif verb == "DATA":
                self.reply("354 Go ahead")
                content = b""
                while (chunk := self.rfile.readline()) != b".\r\n":
                    content += chunk
                server.received.append(content)
                self.reply(server.data_reply)
            elif verb == "QUIT":
                self.reply("221 Bye")
                return
            else:
                self.reply("250 OK")


@pytest.fixture
def smtp_server():
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), SmtpHandler)
    server.daemon_threads = True
    server.commands, server.received, server.envelope = [], [], {}
    server.credentials = None
    server.rcpt_reply, server.data_reply = "250 OK", "250 Queued"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def account(server, **changes):
    values = {
        "host": "127.0.0.1",
        "port": server.server_address[1],
        "security": "none",
        "username": "",
        "password": "",
        **changes,
    }
    return email_connection.SmtpAccount(**values)


def message(**changes):
    values = {
        "attempt_id": str(uuid.uuid4()),
        "sender": "no-reply@example.invalid",
        "reply_to": "finance@example.invalid",
        "recipient": "kim@example.invalid",
        "subject": "Eingangsbestätigung: Erstattungsantrag Erst/1",
        "text": "Hallo Kim,\n.\nein Punkt allein auf einer Zeile, und Umlaute: äöü.\n",
        **changes,
    }
    return Message(**values)


def test_an_smtp_server_receives_the_complete_email(smtp_server):
    smtp_server.credentials = ("kim", "s3cret")
    sent = message(attachment=b"%PDF-1.4 synthetic", filename="claim.pdf")
    result = smtp.SmtpTransport(account(smtp_server, username="kim", password="s3cret")).send(sent)
    assert (result.state, result.message_id) == (DELIVERED, f"smtp-{sent.attempt_id}")
    assert smtp_server.commands == ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]
    assert smtp_server.envelope == {
        "from": "mail from:<no-reply@example.invalid>",
        "to": "rcpt to:<kim@example.invalid>",
    }
    (raw,) = smtp_server.received
    # Seven-bit content: any server accepts it.
    assert all(byte < 128 for byte in raw)
    # The server takes away the dot that protects a line holding only a dot.
    email = message_from_bytes(raw.replace(b"\r\n..\r\n", b"\r\n.\r\n"), policy=policy.default)
    assert email["From"] == "Meldgrove Reimbursement <no-reply@example.invalid>"
    assert (email["To"], email["Reply-To"]) == ("kim@example.invalid", "finance@example.invalid")
    assert email["Subject"] == sent.subject and email["Message-ID"].endswith("@example.invalid>")
    assert email["Date"]
    body, attachment = list(email.iter_parts())
    assert body.get_content().replace("\r\n", "\n") == sent.text
    assert (attachment.get_filename(), attachment.get_content()) == (
        "claim.pdf",
        b"%PDF-1.4 synthetic",
    )


@pytest.mark.parametrize(
    ("changes", "state", "code"),
    [
        ({"rcpt_reply": "550 No such user"}, FAILED, "recipient_rejected"),
        ({"rcpt_reply": "451 Try later"}, PENDING, "smtp_deferred"),
        ({"data_reply": "554 Rejected as spam"}, FAILED, "provider_rejected"),
        ({"data_reply": "452 Mailbox full"}, PENDING, "smtp_deferred"),
        ({"credentials": ("kim", "other")}, PENDING, "smtp_login_failed"),
    ],
)
def test_smtp_refusals_say_whether_to_retry(smtp_server, changes, state, code):
    smtp_server.credentials = ("kim", "s3cret")
    for name, value in changes.items():
        setattr(smtp_server, name, value)
    sending = account(smtp_server, username="kim", password="s3cret")
    result = smtp.SmtpTransport(sending).send(message())
    assert (result.state, result.error_code) == (state, code)


def test_smtp_connection_failures_happen_before_anything_is_sent(smtp_server):
    closed = account(smtp_server, port=1)
    result = smtp.SmtpTransport(closed).send(message())
    assert (result.state, result.error_code) == (PENDING, "smtp_connection")
    # The server offers neither STARTTLS nor a login.
    starttls = account(smtp_server, security="starttls")
    result = smtp.SmtpTransport(starttls).send(message())
    assert (result.state, result.error_code) == (PENDING, "smtp_tls_unavailable")
    login = account(smtp_server, username="kim", password="s3cret")
    result = smtp.SmtpTransport(login).send(message())
    assert (result.state, result.error_code) == (PENDING, "smtp_login_unavailable")
    assert not smtp_server.received


def test_a_connection_lost_during_the_content_leaves_the_outcome_unknown(smtp_server, monkeypatch):
    def lost(self, content):
        raise smtplib.SMTPServerDisconnected("synthetic")

    monkeypatch.setattr(smtplib.SMTP, "data", lost)
    result = smtp.SmtpTransport(account(smtp_server)).send(message())
    assert (result.state, result.error_code) == (UNKNOWN, "provider_outcome_unknown")


def test_claims_go_to_finance_and_participants_through_smtp(delivery, unset, smtp_server):
    EmailSettings(
        provider="smtp",
        from_address="no-reply@example.invalid",
        reply_to_address="finance@example.invalid",
        smtp_host="127.0.0.1",
        smtp_port=smtp_server.server_address[1],
        smtp_security="none",
    ).save()
    deliveries.schedule(delivery.claim)
    Confirmation.objects.get_or_create(claim=delivery.claim)
    queue.enqueue("confirm", delivery.claim)
    while run_one():
        pass
    delivery = Delivery.objects.get(pk=delivery.pk)
    confirmation = Confirmation.objects.get(claim=delivery.claim)
    assert delivery.state == DELIVERED and delivery.delivered_at
    assert confirmation.state == DELIVERED
    assert len(smtp_server.received) == 2
    # SMTP sends no evidence: nothing is left to reconcile.
    assert evidence.reconcile(100) == {"checked": 0, "deferred": 0, "failed": 0}


# The test email


def test_admins_send_a_test_email_with_the_saved_settings(admin_client, settings):
    response = admin_client.post(TEST_URL, {"to": "kim@example.invalid"})
    assert response.status_code == 302 and response.url == URL
    page = admin_client.get(URL).content.decode()
    assert "The test email to kim@example.invalid is in the local outbox" in page
    (path,) = (settings.PRIVATE_STORAGE_ROOT / "outbox").glob("*")
    assert b"Test email from Meldgrove Reimbursement" in path.read_bytes()
    assert admin_client.get(TEST_URL).status_code == 405


def test_the_test_email_explains_what_is_wrong(unset, admin_client, smtp_server, settings):
    admin_client.post(TEST_URL, {"to": "kim@example.invalid"})
    page = admin_client.get(URL).content.decode()
    assert "Email is not set up yet. Missing: a provider, a sender address" in page
    response = admin_client.post(
        URL, smtp_form(smtp_port=str(smtp_server.server_address[1]), smtp_security="none")
    )
    assert response.status_code == 302, errors(response)
    smtp_server.rcpt_reply = "550 No such user"
    admin_client.post(TEST_URL, {"to": "kim@example.invalid"})
    assert "The SMTP server refused the recipient." in admin_client.get(URL).content.decode()
    smtp_server.rcpt_reply = "250 OK"
    admin_client.post(TEST_URL, {"to": "kim@example.invalid"})
    page = admin_client.get(URL).content.decode()
    assert "The SMTP server accepted the test email to kim@example.invalid." in page
    settings.TEST_RECIPIENT_ALLOWLIST = ["finance@example.invalid"]
    admin_client.post(TEST_URL, {"to": "kim@example.invalid"})
    page = admin_client.get(URL).content.decode()
    assert "TEST_RECIPIENT_ALLOWLIST does not include the recipient." in page
    assert len(smtp_server.received) == 1


# The webhook


def test_a_signed_webhook_uses_the_saved_secret_and_is_shown(unset, admin_client, client):
    saved = EmailSettings(provider="mailersend")
    saved.set_secret("webhook_secret", "saved-signing-secret")
    saved.save()
    body = json.dumps(
        {
            "type": "activity.delivered",
            "created_at": timezone.now().isoformat(),
            "data": {"id": "event-1", "message_id": "m-1", "recipient": "a@example.invalid"},
        }
    ).encode()
    wrong = hmac.new(b"other", body, hashlib.sha256).hexdigest()
    right = hmac.new(b"saved-signing-secret", body, hashlib.sha256).hexdigest()
    webhook = "/webhooks/mailersend/"
    response = client.post(
        webhook, data=body, content_type="application/json", headers={"Signature": wrong}
    )
    assert response.status_code == 401 and not EmailSettings.load().webhook_received_at
    response = client.post(
        webhook, data=body, content_type="application/json", headers={"Signature": right}
    )
    assert response.status_code == 200 and EmailSettings.load().webhook_received_at
    assert "Last signed event:" in admin_client.get(URL).content.decode()
