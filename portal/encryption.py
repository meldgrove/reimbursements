"""Secrets that admins enter, such as an email provider's API token, encrypted at rest.

The key is derived from DJANGO_SECRET_KEY, so a database backup alone does not reveal
them. Values sealed with a key in SECRET_KEY_FALLBACKS still open; after the secret key
changes without a fallback they cannot be read and have to be entered again.
"""

import base64

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings

PURPOSE = b"reimbursements: secrets entered in the admin area"


def _fernet(secret_key):
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=PURPOSE).derive(
        secret_key.encode()
    )
    return Fernet(base64.urlsafe_b64encode(key))


def _keys():
    secret_keys = [settings.SECRET_KEY, *getattr(settings, "SECRET_KEY_FALLBACKS", [])]
    return MultiFernet([_fernet(secret_key) for secret_key in secret_keys])


def seal(value):
    """`value` encrypted with the current secret key; empty stays empty."""
    return _keys().encrypt(value.encode()).decode("ascii") if value else ""


def unseal(sealed):
    """The value `seal` encrypted: "" for empty, None when no secret key opens it."""
    if not sealed:
        return ""
    try:
        return _keys().decrypt(sealed.encode("ascii")).decode()
    except (InvalidToken, UnicodeError):
        return None
