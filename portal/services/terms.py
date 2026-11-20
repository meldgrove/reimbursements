"""Terms: what a participant agrees to and what their entries are validated against.

A form's terms are its template's declaration and declaration version, the privacy
notice, the form's purpose options, the template's travel mode and its mileage rate if
mileage is allowed. A draft is opened against the terms of its form and accepted only
while the form keeps them: their digest is the draft's revision. Validation reads a
form only through its terms, so every change validation would notice sends open drafts
back. Wording, opening times, internal values and contacts are not terms; the claim
snapshot records them at acceptance.
"""

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal

from portal.i18n import language
from portal.models import PrivacyNotice
from portal.services.outbound import recipient_approved

# Part of every revision. Raising it sends every open draft back.
INTAKE_VERSION = 2

# Why a form takes no new claims (`refusal`): it is closed, or it is open but unavailable.
CLOSED = "closed"
UNAPPROVED_RECIPIENT = "unapproved_recipient"
NO_PRIVACY_NOTICE = "no_privacy_notice"


@dataclass(frozen=True)
class Terms:
    declaration: str
    declaration_version: str
    # The current privacy notice; without one the form is unavailable.
    privacy_notice: PrivacyNotice | None
    # Distinct preset purposes in order; empty for free text.
    purpose_options: tuple[str, ...]
    # A FormTemplate.Travel value.
    travel: str
    # EUR per kilometre; None when the template allows no mileage.
    mileage_rate: Decimal | None

    @property
    def privacy_version(self):
        return self.privacy_notice.version if self.privacy_notice else None

    @property
    def fixed_purpose(self):
        """The purpose a single preset fixes, or None."""
        return self.purpose_options[0] if len(self.purpose_options) == 1 else None

    @property
    def revision(self):
        """The digest a draft is opened against. Open drafts keep working across releases
        only while it is computed exactly like this."""
        configuration = {
            "intake_version": INTAKE_VERSION,
            "declaration": self.declaration,
            "declaration_version": self.declaration_version,
            "privacy_version": self.privacy_version,
            "purpose_options": list(self.purpose_options),
            "travel": self.travel,
            "mileage_rate": None if self.mileage_rate is None else f"{self.mileage_rate:.2f}",
        }
        encoded = json.dumps(configuration, sort_keys=True, ensure_ascii=False).encode()
        return hashlib.sha256(encoded).hexdigest()[:16]

    def script_configuration(self):
        """What the form script needs of these terms."""
        return {
            "travel": self.travel,
            "mileage_rate": _text(self.mileage_rate),
            "purpose_options": bool(self.purpose_options),
            "fixed_purpose": self.fixed_purpose,
        }


def _text(rate):
    return None if rate is None else str(rate)


def of(form):
    """The terms `form` offers now."""
    template = form.template
    # Repeated presets are one option, so a single distinct purpose stays fixed text.
    options = (line.strip() for line in form.purpose_options.splitlines() if line.strip())
    return Terms(
        declaration=template.declaration,
        declaration_version=template.declaration_version,
        privacy_notice=PrivacyNotice.current(),
        purpose_options=tuple(dict.fromkeys(options)),
        travel=template.travel,
        mileage_rate=template.mileage_rate if template.mileage_enabled else None,
    )


def refusal(form, privacy_notice):
    """Why `form` takes no new claims now, or "" while it does. `privacy_notice` is the
    current one (`PrivacyNotice.current()`, or the one `of(form)` offers).

    A form takes claims while it is open (`Form.is_open`) and available: its inbox is an
    approved Finance inbox and a privacy notice exists for participants to acknowledge.
    The Draft gate, the start page and the admin's Open now follow this one rule.
    """
    if not form.is_open():
        return CLOSED
    if not recipient_approved(form.recipient):
        return UNAPPROVED_RECIPIENT
    if privacy_notice is None:
        return NO_PRIVACY_NOTICE
    return ""


def accepting(form):
    """Whether `form` takes new claims now."""
    return not refusal(form, PrivacyNotice.current())


def snapshot(form, terms):
    """The claim's record of `form` and the `terms` its participant accepted."""
    return {
        "name": form.name,
        "slug": form.slug,
        "template": form.template.name,
        "internal_values": form.internal_values(),
        "recipient": form.recipient,
        "support_email": form.support_email,
        "declaration": terms.declaration,
        "declaration_version": terms.declaration_version,
        "privacy_version": terms.privacy_version,
        "mileage_rate": _text(terms.mileage_rate),
        "revision": terms.revision,
        # The PDF and the emails use the language the participant saw.
        "language": language(),
    }
