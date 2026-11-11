import json
import time
import uuid
from urllib.parse import parse_qs, urlsplit

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import SuspiciousOperation
from django.test import RequestFactory
from mozilla_django_oidc.auth import OIDCAuthenticationBackend

from portal import roles
from portal.admin import STATUS_ORDER, claim_status_parts
from portal.auth import KeycloakBackend, keycloak_logout_url
from portal.models import Claim, Delivery, DeliveryAttempt, Form, Job, Operation, PrivacyNotice

pytestmark = pytest.mark.django_db

ADMIN_GROUP = "/reimbursements/admins"
EDITOR_GROUP = "/reimbursements/editors"


@pytest.fixture
def oidc(settings):
    settings.OIDC_RP_CLIENT_ID = "reimbursement-portal"
    settings.OIDC_RP_CLIENT_SECRET = "ci-only"
    settings.OIDC_ENABLED = True
    settings.KEYCLOAK_ADMIN_GROUP = ADMIN_GROUP
    settings.KEYCLOAK_EDITOR_GROUP = EDITOR_GROUP


def user_with(role, name):
    user = get_user_model().objects.create_user(name, email=f"{name}@example.invalid")
    roles.assign(user, {role})
    return user


@pytest.fixture
def admin_client(client):
    client.force_login(
        user_with(roles.TEMPLATE_ADMIN, "admin"),
        backend="django.contrib.auth.backends.ModelBackend",
    )
    return client


@pytest.fixture
def editor(db):
    return user_with(roles.FORM_EDITOR, "editor")


def claims(oidc, **changes):
    return {
        "sub": "subject-1",
        "email": "person@example.invalid",
        "email_verified": True,
        "given_name": "Kim",
        "family_name": "Muster",
        "groups": [EDITOR_GROUP],
        **changes,
    }


def test_sign_in_maps_groups_to_roles_and_keys_users_by_subject(oidc):
    backend = KeycloakBackend()
    assert backend.verify_claims(claims(oidc))
    user = backend.create_user(claims(oidc))
    assert user.username == "subject-1" and user.is_staff
    assert roles.roles(user) == {roles.FORM_EDITOR}
    backend.update_user(user, claims(oidc, groups=[ADMIN_GROUP, "/other"]))
    assert roles.is_template_admin(user)
    assert list(backend.filter_users_by_claims(claims(oidc))) == [user]
    assert not backend.filter_users_by_claims(claims(oidc, sub="subject-2")).exists()


@pytest.mark.parametrize(
    "changes",
    [{"groups": ["/unrelated"]}, {"groups": None}, {"email_verified": False}],
)
def test_sign_in_requires_a_portal_group_and_verified_email(oidc, changes):
    assert not KeycloakBackend().verify_claims(claims(oidc, **changes))


def token(**changes):
    now = time.time()
    return {
        "iss": "https://auth.example.invalid/realms/reimbursements",
        "aud": "reimbursement-portal",
        "azp": "reimbursement-portal",
        "sub": "subject-1",
        "nonce": "nonce",
        "iat": now,
        "exp": now + 300,
        **changes,
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://other.example.invalid/realms/reimbursements"},
        {"aud": "another-client"},
        {"aud": ["reimbursement-portal", "another-client"]},
        {"azp": "another-client"},
        {"exp": time.time() - 1},
        {"iat": time.time() + 3600},
        {"nonce": ""},
    ],
)
def test_id_tokens_must_be_issued_for_this_client(oidc, monkeypatch, changes):
    monkeypatch.setattr(OIDCAuthenticationBackend, "verify_token", lambda *a, **k: token(**changes))
    with pytest.raises(SuspiciousOperation):
        KeycloakBackend().verify_token("signed")
    monkeypatch.setattr(OIDCAuthenticationBackend, "verify_token", lambda *a, **k: token())
    assert KeycloakBackend().verify_token("signed")["sub"] == "subject-1"


def test_admin_login_redirects_to_keycloak(client, oidc):
    response = client.get("/admin/login/?next=/admin/portal/form/")
    assert response.status_code == 302
    assert response.url == "/oidc/authenticate/?next=%2Fadmin%2Fportal%2Fform%2F"


def test_sign_in_uses_pkce(client, oidc):
    response = client.get("/oidc/authenticate/")
    assert response.status_code == 302
    query = parse_qs(urlsplit(response.url).query)
    assert query["code_challenge_method"] == ["S256"] and query["code_challenge"][0]


def test_logout_ends_the_keycloak_session(oidc, settings):
    request = RequestFactory().get("/")
    request.session = {"oidc_id_token": "id-token"}
    url = urlsplit(keycloak_logout_url(request))
    assert url.path.endswith("/realms/reimbursements/protocol/openid-connect/logout")
    query = parse_qs(url.query)
    assert query["id_token_hint"] == ["id-token"]
    assert query["client_id"] == ["reimbursement-portal"]


def test_users_without_a_role_cannot_use_the_admin(client):
    client.force_login(
        get_user_model().objects.create_user("nobody"),
        backend="django.contrib.auth.backends.ModelBackend",
    )
    assert client.get("/admin/").status_code == 302


def test_admin_creates_a_form_from_a_template(admin_client, template, settings):
    assert admin_client.get("/admin/portal/form/add/").status_code == 200
    url = f"/admin/portal/form/add/?template={template.pk}"
    page = admin_client.get(url).content.decode()
    assert "Kostenstelle (KST)" in page and "finance@example.invalid" in page
    data = {
        "name": "Werkstatt Herbst",
        "slug": "werkstatt-herbst",
        "value_kst": "",
        "value_ktr": "4711",
        "recipient": "finance@example.invalid",
        "support_email": "team@example.invalid",
        "purpose_options": "Teilnahme\nMitwirkung",
        "_publication": "publish",
    }
    response = admin_client.post(url, data)
    assert response.status_code == 200 and not Form.objects.exists()
    data["value_kst"] = "1234"
    response = admin_client.post(url, data)
    assert response.status_code == 302, response.content
    form = Form.objects.get()
    assert form.template == template
    assert form.field_values == {"kst": "1234", "ktr": "4711"}
    assert form.owners.get().username == "admin"
    assert form.internal_values() == [
        ("Kostenstelle (KST)", "1234"),
        ("Kostenträger (KTR)", "4711"),
    ]


def test_unapproved_recipients_cannot_be_chosen(admin_client, template):
    url = f"/admin/portal/form/add/?template={template.pk}"
    response = admin_client.post(
        url,
        {
            "name": "Werkstatt",
            "slug": "werkstatt",
            "value_kst": "1234",
            "recipient": "attacker@example.invalid",
            "support_email": "team@example.invalid",
        },
    )
    assert response.status_code == 200 and not Form.objects.exists()


def test_editors_see_only_their_forms_and_claims(client, editor, accepted):
    other = Form.objects.create(
        template=accepted.form.template,
        slug="other",
        name="Andere Werkstatt",
        recipient="finance@example.invalid",
        support_email="finance@example.invalid",
    )
    other.owners.add(editor)
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    forms = client.get("/admin/portal/form/").content.decode()
    assert "Andere Werkstatt" in forms and "Test Workshop" not in forms
    assert client.get(f"/admin/portal/form/{accepted.form.pk}/change/").status_code == 302
    assert "Alex Beispiel" not in client.get("/admin/portal/claim/").content.decode()
    assert client.get(f"/admin/portal/claim/{accepted.pk}/change/").status_code == 302
    accepted.form.owners.add(editor)
    page = client.get("/admin/portal/claim/").content.decode()
    assert "Alex Beispiel" in page and "participant@example.invalid" in page
    assert "DE89" not in page
    detail = client.get(f"/admin/portal/claim/{accepted.pk}/change/").content.decode()
    assert "Alex Beispiel" in detail and "Erneut verarbeiten" not in detail
    assert client.get(f"/admin/portal/claim/{accepted.pk}/erneut-versuchen/").status_code == 403


def test_editors_cannot_change_templates_or_the_privacy_notice(client, editor, template):
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    assert client.get(f"/admin/portal/formtemplate/{template.pk}/change/").status_code == 200
    response = client.post(f"/admin/portal/formtemplate/{template.pk}/change/", {"name": "X"})
    assert response.status_code == 403
    assert client.get("/admin/portal/privacynotice/").status_code == 403
    assert client.get("/admin/portal/formtemplate/add/").status_code == 403


def test_only_template_admins_choose_the_start_page_form(client, editor, form):
    data = {
        "name": form.name,
        "slug": form.slug,
        "value_kst": "TEST-KST",
        "recipient": form.recipient,
        "support_email": form.support_email,
        "primary": "on",
    }
    current = Form.objects.create(
        template=form.template,
        slug="allgemein",
        name="Allgemein",
        recipient=form.recipient,
        support_email=form.support_email,
        primary=True,
    )
    url = f"/admin/portal/form/{form.pk}/change/"
    form.owners.add(editor)
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    assert client.post(url, data).status_code == 302
    form.refresh_from_db()
    assert not form.primary
    client.force_login(
        user_with(roles.TEMPLATE_ADMIN, "admin"),
        backend="django.contrib.auth.backends.ModelBackend",
    )
    assert client.post(url, data).status_code == 302
    form.refresh_from_db()
    current.refresh_from_db()
    assert form.primary and not current.primary


def form_settings(form, **changes):
    return {
        "_autosave": "1",
        "name": form.name,
        "slug": form.slug,
        "value_kst": form.field_values.get("kst", ""),
        "value_ktr": form.field_values.get("ktr", ""),
        "recipient": form.recipient,
        "support_email": form.support_email,
        **changes,
    }


def test_new_forms_autosave_as_incomplete_drafts(admin_client, template, client):
    url = f"/admin/portal/form/add/?template={template.pk}"
    page = admin_client.get(url).content.decode()
    assert "Entwurf" in page and "Veröffentlichen" in page
    assert 'name="active"' not in page and 'name="status"' not in page
    assert "Verantwortliche" not in page and 'name="owners"' not in page
    assert 'name="_save"' not in page and 'name="_continue"' not in page
    response = admin_client.post(url, {"_autosave": "1", "instructions": "Erste Notiz"})
    assert response.status_code == 200, response.content
    form = Form.objects.get()
    assert form.status == Form.Status.DRAFT
    assert form.instructions == "Erste Notiz" and form.name == "Neues Formular" and form.slug
    assert form.field_values == {"kst": "", "ktr": ""}
    assert form.owners.get().username == "admin"
    assert response.json()["can_delete"]
    assert response.json()["url"] == f"/admin/portal/form/{form.pk}/change/"
    client.logout()
    assert client.get(response.json()["link"]).status_code == 403


def test_autosave_keeps_a_draft_and_updates_the_existing_form(admin_client, form):
    form.status = Form.Status.DRAFT
    form.save()
    url = f"/admin/portal/form/{form.pk}/change/"
    response = admin_client.post(url, form_settings(form, name="Neuer Name", value_kst=""))
    assert response.status_code == 200, response.content
    form.refresh_from_db()
    assert form.name == "Neuer Name" and form.field_values["kst"] == ""
    assert form.status == Form.Status.DRAFT and Form.objects.count() == 1
    assert response.json()["status_label"] == "Entwurf"


def test_retrying_a_first_autosave_updates_the_same_draft(admin_client, template):
    url = f"/admin/portal/form/add/?template={template.pk}"
    data = {"_autosave": "1", "_creation_key": str(uuid.uuid4()), "name": "Neues Formular"}
    first = admin_client.post(url, data)
    assert first.status_code == 200
    data["instructions"] = "Nach Verbindungsfehler erneut gespeichert"
    second = admin_client.post(url, data)
    assert second.status_code == 200, second.content
    assert second.json()["url"] == first.json()["url"]
    assert second.json()["slug"] == first.json()["slug"]
    assert Form.objects.count() == 1
    assert Form.objects.get().instructions == data["instructions"]


def test_publishing_validates_then_unpublishing_closes_the_form(admin_client, client, form):
    form.status = Form.Status.DRAFT
    form.save()
    url = f"/admin/portal/form/{form.pk}/change/"
    invalid = form_settings(form, _publication="publish", value_kst="", support_email="")
    response = admin_client.post(url, invalid)
    assert response.status_code == 400
    assert set(response.json()["errors"]) == {"value_kst", "support_email"}
    form.refresh_from_db()
    assert form.status == Form.Status.DRAFT
    response = admin_client.post(url, form_settings(form, _publication="publish"))
    assert response.status_code == 200 and response.json()["status"] == "published"
    assert not response.json()["can_delete"]
    form.refresh_from_db()
    assert form.is_open()
    assert "Unveröffentlichen" in admin_client.get(url).content.decode()
    response = admin_client.post(url, form_settings(form, _publication="unpublish"))
    assert response.status_code == 200 and response.json()["status"] == "draft"
    assert response.json()["can_delete"]
    form.refresh_from_db()
    assert not form.is_open()
    client.logout()
    assert client.get(f"/f/{form.slug}/").status_code == 403


def test_autosave_preserves_published_status_and_rejects_invalid_settings(admin_client, form):
    url = f"/admin/portal/form/{form.pk}/change/"
    response = admin_client.post(url, form_settings(form, name="Aktualisiert"))
    assert response.status_code == 200 and response.json()["status"] == "published"
    form.refresh_from_db()
    assert form.name == "Aktualisiert" and form.is_open()
    response = admin_client.post(url, form_settings(form, name="Nicht speichern", value_kst=""))
    assert response.status_code == 400
    form.refresh_from_db()
    assert form.name == "Aktualisiert" and form.field_values["kst"]
    assert form.status == Form.Status.PUBLISHED


def test_autosaving_a_published_form_keeps_open_drafts_accepting(admin_client, prepared):
    form = prepared["form"]
    url = f"/admin/portal/form/{form.pk}/change/"
    changes = {"instructions": "Tippfehler korrigiert", "closes_at_0": "2099-01-01"}
    for _ in range(3):
        response = admin_client.post(url, form_settings(form, **changes, closes_at_1="12:00:00"))
        assert response.status_code == 200, response.content
    response = prepared["client"].post(
        "/f/test/submit/", data=json.dumps(prepared["data"]), content_type="application/json"
    )
    assert response.status_code == 202, response.content


def test_publication_keeps_the_opening_schedule(admin_client, form):
    url = f"/admin/portal/form/{form.pk}/change/"
    response = admin_client.post(
        url,
        form_settings(form, _publication="publish", opens_at_0="2099-01-01", opens_at_1="12:00:00"),
    )
    assert response.status_code == 200, response.content
    form.refresh_from_db()
    assert form.status == Form.Status.PUBLISHED and not form.is_open()


def test_autosave_and_publication_require_ownership(client, editor, form):
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    url = f"/admin/portal/form/{form.pk}/change/"
    response = client.post(url, form_settings(form, _publication="unpublish"))
    assert response.status_code == 404
    form.refresh_from_db()
    assert form.status == Form.Status.PUBLISHED
    form.owners.add(editor)
    response = client.post(url, form_settings(form, _publication="unpublish"))
    assert response.status_code == 200
    assert not response.json()["can_delete"]
    form.refresh_from_db()
    assert form.status == Form.Status.DRAFT
    assert form.owners.filter(pk=editor.pk).exists()


def test_status_cannot_be_changed_through_autosave_fields(admin_client, form):
    url = f"/admin/portal/form/{form.pk}/change/"
    response = admin_client.post(url, form_settings(form, status="draft"))
    assert response.status_code == 200
    form.refresh_from_db()
    assert form.status == Form.Status.PUBLISHED


def test_form_list_shows_publication_status(admin_client, form):
    page = admin_client.get("/admin/portal/form/").content.decode()
    assert "Veröffentlicht" in page and ">Status<" in page


def test_draft_deletion_requires_confirmation(admin_client, form):
    form.status = Form.Status.DRAFT
    form.save()
    url = f"/admin/portal/form/{form.pk}/delete/"
    response = admin_client.get(url)
    assert response.status_code == 200
    assert "Entwurf endgültig löschen" in response.content.decode()
    assert "Abbrechen" in response.content.decode()
    assert Form.objects.filter(pk=form.pk).exists()
    response = admin_client.post(url, {"csrfmiddlewaretoken": "not-a-confirmation"})
    assert response.status_code == 400
    assert Form.objects.filter(pk=form.pk).exists()
    response = admin_client.post(url, {"post": "yes"})
    assert response.status_code == 302
    assert not Form.objects.filter(pk=form.pk).exists()


def test_published_forms_cannot_be_deleted(admin_client, form):
    response = admin_client.get(f"/admin/portal/form/{form.pk}/change/")
    assert response.context["form_delete_hidden"]
    assert not response.context["has_delete_permission"]
    url = f"/admin/portal/form/{form.pk}/delete/"
    assert admin_client.get(url).status_code == 403
    assert admin_client.post(url, {"post": "yes"}).status_code == 403
    assert Form.objects.filter(pk=form.pk).exists()


def test_publishing_after_opening_delete_confirmation_prevents_deletion(admin_client, form):
    form.status = Form.Status.DRAFT
    form.save()
    url = f"/admin/portal/form/{form.pk}/delete/"
    assert admin_client.get(url).status_code == 200
    form.status = Form.Status.PUBLISHED
    form.save()
    assert admin_client.post(url, {"post": "yes"}).status_code == 403
    assert Form.objects.filter(pk=form.pk).exists()


def test_drafts_with_submitted_claims_cannot_be_deleted(admin_client, accepted):
    form = accepted.form
    form.status = Form.Status.DRAFT
    form.save()
    response = admin_client.get(f"/admin/portal/form/{form.pk}/change/")
    assert response.context["form_delete_hidden"]
    url = f"/admin/portal/form/{form.pk}/delete/"
    assert admin_client.post(url, {"post": "yes"}).status_code == 403
    assert Claim.objects.filter(pk=accepted.pk).exists()


def test_bulk_deletion_cannot_include_a_published_form(admin_client, form):
    draft = Form.objects.create(
        template=form.template,
        name="Entwurf",
        slug="entwurf",
        recipient=form.recipient,
        support_email=form.support_email,
    )
    response = admin_client.post(
        "/admin/portal/form/",
        {
            "action": "delete_selected",
            "_selected_action": [str(form.pk), str(draft.pk)],
            "post": "yes",
        },
    )
    assert response.status_code == 403
    assert Form.objects.filter(pk__in=[form.pk, draft.pk]).count() == 2


def test_admin_adds_a_new_privacy_notice_version(admin_client, privacy_notice):
    page = admin_client.get("/admin/portal/privacynotice/add/").content.decode()
    assert privacy_notice.text.splitlines()[0][:20] in page
    response = admin_client.post("/admin/portal/privacynotice/add/", {"text": "Neue Fassung."})
    assert response.status_code == 302
    current = PrivacyNotice.current()
    assert current.text == "Neue Fassung." and current.created_by == "admin@example.invalid"
    assert admin_client.post(
        f"/admin/portal/privacynotice/{current.pk}/change/", {"text": "Edit"}
    ).status_code in {403, 302}
    assert PrivacyNotice.current().text == "Neue Fassung."


def test_admin_retries_a_failed_render_with_an_audited_reason(admin_client, accepted):
    Claim.objects.filter(pk=accepted.pk).update(state=Claim.State.FAILED, error_code="timeout")
    Job.objects.all().delete()
    url = f"/admin/portal/claim/{accepted.pk}/erneut-versuchen/"
    assert "Erneut verarbeiten" in admin_client.get(url).content.decode()
    assert admin_client.post(url, {"reason": ""}).status_code == 200
    response = admin_client.post(url, {"reason": "Sandbox repariert"})
    assert response.status_code == 302
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED
    operation = Operation.objects.get()
    assert (operation.actor, operation.reason) == ("admin@example.invalid", "Sandbox repariert")


def test_admin_resend_requires_duplicate_risk_acknowledgment(admin_client, delivery):
    delivery.state = "delivered"
    delivery.save()
    url = f"/admin/portal/claim/{delivery.claim_id}/erneut-versuchen/"
    response = admin_client.post(url, {"reason": "Das Postfach hat nichts erhalten"})
    assert response.status_code == 200 and "doppelten Versands" in response.content.decode()
    response = admin_client.post(
        url, {"reason": "Das Postfach hat nichts erhalten", "acknowledge_duplicate_risk": "on"}
    )
    assert response.status_code == 302
    delivery.refresh_from_db()
    assert delivery.state == "pending"


def second_claim(form):
    return Claim.objects.create(
        form=form,
        full_name="Sam Zweitens",
        email="second@example.invalid",
        street="Teststraße 2",
        postal_code="12345",
        city="Berlin",
        country="DE",
        account_holder="Sam Zweitens",
        iban="DE89370400440532013000",
        purpose="Synthetischer Test",
        snapshot={},
    )


def test_admin_deletes_a_claim_only_after_confirmation(admin_client, accepted):
    purge_url = f"/admin/portal/claim/{accepted.pk}/loeschen/"
    page = admin_client.get(f"/admin/portal/claim/{accepted.pk}/change/").content.decode()
    assert purge_url in page
    response = admin_client.get(purge_url)
    page = response.content.decode()
    assert response.status_code == 200
    assert "Antrag endgültig löschen" in page and "Abbrechen" in page
    assert "Noch nicht an Finance gesendet" in page and "Alex Beispiel" in page
    assert admin_client.post(purge_url, {"reason": ""}).status_code == 200
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED and accepted.iban
    response = admin_client.post(purge_url, {"reason": "Testeinreichung"})
    assert response.status_code == 302 and response.url == "/admin/portal/claim/"
    assert not Claim.objects.filter(pk=accepted.pk).exists()
    operation = Operation.objects.get()
    assert (operation.claim_id, operation.action, operation.actor, operation.reason) == (
        None,
        "delete",
        "admin@example.invalid",
        "Testeinreichung",
    )
    page = admin_client.get("/admin/portal/claim/").content.decode()
    assert str(accepted.pk) not in page and "Gelöscht" not in page
    assert admin_client.get(purge_url).status_code == 404


def test_deletion_warns_when_finance_may_already_hold_the_pdf(admin_client, delivery):
    DeliveryAttempt.objects.create(delivery=delivery, state="delivered")
    page = admin_client.get(f"/admin/portal/claim/{delivery.claim_id}/loeschen/").content.decode()
    assert "Bereits an Finance gesendet" in page
    assert "Noch nicht an Finance gesendet" not in page


def test_deletion_is_refused_while_the_claim_is_processed(admin_client, accepted):
    Job.objects.filter(kind="render").update(state="running")
    response = admin_client.post(
        f"/admin/portal/claim/{accepted.pk}/loeschen/", {"reason": "Testeinreichung"}
    )
    assert response.status_code == 200 and "gerade verarbeitet" in response.content.decode()
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED
    assert not Operation.objects.exists()


def test_an_interrupted_deletion_reports_that_cleanup_finishes_it(
    admin_client, accepted, monkeypatch
):
    def interrupted(claim_id):
        raise OSError("storage unavailable")

    monkeypatch.setattr("portal.services.retention.purge_claim", interrupted)
    response = admin_client.post(
        f"/admin/portal/claim/{accepted.pk}/loeschen/", {"reason": "Testeinreichung"}, follow=True
    )
    assert "wird in wenigen Minuten automatisch abgeschlossen" in response.content.decode()
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.PURGING
    assert Operation.objects.get().action == "delete"


def test_bulk_deletion_confirms_then_deletes_the_selected_claims(admin_client, accepted):
    other = second_claim(accepted.form)
    selected = [str(accepted.pk), str(other.pk)]
    assert "delete_claims" in admin_client.get("/admin/portal/claim/").content.decode()
    response = admin_client.post(
        "/admin/portal/claim/",
        {"action": "delete_claims", "_selected_action": selected, "index": "0"},
    )
    page = response.content.decode()
    assert response.status_code == 200 and "2 Anträge endgültig löschen" in page
    assert "Alex Beispiel" in page and "Sam Zweitens" in page
    assert Claim.objects.count() == 2
    confirmation = {"action": "delete_claims", "_selected_action": selected, "post": "yes"}
    response = admin_client.post("/admin/portal/claim/", {**confirmation, "reason": ""})
    assert response.status_code == 200
    assert Claim.objects.count() == 2
    response = admin_client.post("/admin/portal/claim/", {**confirmation, "reason": "Tests"})
    assert response.status_code == 302
    assert not Claim.objects.exists()
    assert Operation.objects.filter(action="delete", reason="Tests").count() == 2


def test_editors_cannot_delete_claims(client, editor, accepted):
    accepted.form.owners.add(editor)
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    purge_url = f"/admin/portal/claim/{accepted.pk}/loeschen/"
    assert (
        purge_url not in client.get(f"/admin/portal/claim/{accepted.pk}/change/").content.decode()
    )
    assert "delete_claims" not in client.get("/admin/portal/claim/").content.decode()
    assert client.get(purge_url).status_code == 403
    assert client.post(purge_url, {"reason": "Test"}).status_code == 403
    client.post(
        "/admin/portal/claim/",
        {"action": "delete_claims", "_selected_action": [str(accepted.pk)], "post": "yes"},
    )
    accepted.refresh_from_db()
    assert accepted.state == Claim.State.RECEIVED
    assert not Operation.objects.exists()


def test_status_filter_lists_the_claims_its_status_column_shows(admin_client, accepted):
    claim_states = [
        (Claim.State.RENDERING, None),
        (Claim.State.READY, None),
        (Claim.State.FAILED, None),
        (Claim.State.READY, "pending"),
        (Claim.State.READY, "delivered"),
        (Claim.State.READY, "failed"),
        (Claim.State.READY, "send_unknown"),
        (Claim.State.PURGING, None),
        (Claim.State.PURGING, "delivered"),
    ]
    for claim_state, delivery_state in claim_states:
        claim = second_claim(accepted.form)
        Claim.objects.filter(pk=claim.pk).update(state=claim_state)
        if delivery_state:
            Delivery.objects.create(
                claim=claim, recipient="finance@example.invalid", state=delivery_state
            )
    columns = {claim.pk: claim_status_parts(claim)[0] for claim in Claim.objects.all()}
    assert set(columns.values()) <= set(STATUS_ORDER)

    page = admin_client.get("/admin/portal/claim/")
    html = page.content.decode()
    assert 'data-filter-title="Status"' in html
    assert 'data-filter-title="Verarbeitung"' not in html
    assert 'data-filter-title="Versand"' not in html
    for state in STATUS_ORDER:
        page = admin_client.get("/admin/portal/claim/", {"status": state})
        listed = {claim.pk for claim in page.context["cl"].result_list}
        assert listed == {pk for pk, shown in columns.items() if shown == state}, state


def test_claim_search_finds_a_full_reference(admin_client, accepted):
    page = admin_client.get(f"/admin/portal/claim/?q={accepted.reference}").content.decode()
    assert "Alex Beispiel" in page
    page = admin_client.get(f"/admin/portal/claim/?q={accepted.reference[:8]}").content.decode()
    assert "Alex Beispiel" not in page


def test_admin_home_opens_the_claims(admin_client):
    response = admin_client.get("/admin/")
    assert response.status_code == 302 and response.url == "/admin/portal/claim/"
    assert admin_client.get("/admin/portal/").url == "/admin/portal/claim/"


def test_sidebar_shows_the_admin_section_only_to_template_admins(
    admin_client, client, editor, oidc
):
    page = admin_client.get("/admin/portal/claim/").content.decode()
    assert 'href="/admin/portal/formtemplate/"' in page
    assert "Willkommen" not in page and "Website anzeigen" not in page
    assert "/realms/reimbursements/account/" in page
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    page = client.get("/admin/portal/claim/").content.decode()
    assert 'href="/admin/portal/claim/"' in page
    assert 'href="/admin/portal/formtemplate/"' not in page


def suggestions(client, query):
    response = client.get("/admin/suche/vorschlaege/", {"q": query})
    assert response.status_code == 200
    return {group["label"]: group["items"] for group in response.json()["groups"]}


def test_search_finds_only_what_the_person_may_open(client, editor, accepted, template):
    client.force_login(editor, backend="django.contrib.auth.backends.ModelBackend")
    assert suggestions(client, "Alex") == {}
    assert suggestions(client, template.name[:6]) == {}
    accepted.form.owners.add(editor)
    groups = suggestions(client, "Alex")
    assert [item["name"] for item in groups["Anträge"]] == ["Alex Beispiel"]
    assert groups["Anträge"][0]["url"] == f"/admin/portal/claim/{accepted.pk}/change/"
    assert suggestions(client, accepted.reference[:8]) == {}
    assert "Anträge" in suggestions(client, accepted.reference)
    assert suggestions(client, "formu")["Navigation"][0]["url"] == "/admin/portal/form/"
    assert suggestions(client, "a") == {}


def test_template_admins_find_templates_and_settings(admin_client, template):
    groups = suggestions(admin_client, template.name[:6])
    assert groups["Vorlagen"][0]["url"] == f"/admin/portal/formtemplate/{template.pk}/change/"
    assert suggestions(admin_client, "datenschutz")["Navigation"][0]["name"] == "Datenschutzhinweis"


def test_search_page_lists_all_results(admin_client, accepted):
    page = admin_client.get("/admin/suche/", {"q": "Beispiel"}).content.decode()
    assert "Alex Beispiel" in page and f"/admin/portal/claim/{accepted.pk}/change/" in page
    assert "Keine Treffer" in admin_client.get("/admin/suche/", {"q": "zzz"}).content.decode()


def test_list_search_box_sends_the_query_and_reset_clears_it(admin_client, accepted):
    page = admin_client.get("/admin/portal/claim/", {"q": "Alex", "status": "received"})
    html = page.content.decode()
    assert 'name="q" value="Alex"' in html
    assert '<input type="hidden" name="status" value="received">' in html
    assert '<input type="hidden" name="q"' not in html
    assert 'href="?"' in html


def test_local_admin_sidebar_has_no_identity_provider_account_link(admin_client):
    page = admin_client.get("/admin/portal/claim/").content.decode()
    assert "/account/" not in page
