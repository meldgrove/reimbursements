"""The admission budget of a client network, shared by its new drafts and uploads.

One DraftAdmission row per network, keyed by a secret digest of it. It counts new drafts
and uploads (number and bytes) over a 24-hour window, and uploads over a one-minute
window; this module resets both. Lock order is Draft, then network budget, then capacity.
"""

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac

from portal.models import DraftAdmission


def _locked(network):
    key = salted_hmac("draft-admission", network).hexdigest()
    budget, _ = DraftAdmission.objects.select_for_update().get_or_create(key=key)
    now = timezone.now()
    if budget.window_start <= now - timedelta(hours=24):
        budget.window_start, budget.count = now, 0
        budget.upload_count = budget.upload_bytes = 0
        budget.upload_window_start, budget.upload_window_count = now, 0
    if budget.upload_window_start <= now - timedelta(minutes=1):
        budget.upload_window_start, budget.upload_window_count = now, 0
    return budget


@transaction.atomic
def charge_draft(network):
    """Count a new draft against the network; False when its drafts for the day are spent."""
    budget = _locked(network)
    if budget.count >= settings.MAX_DRAFTS_PER_NETWORK:
        return False
    budget.count += 1
    budget.save()
    return True


def charge_upload(network, size):
    """Count an upload against the network; False when its upload budget is spent.

    Runs in the upload's transaction, so a later admission failure refunds the charge.
    """
    budget = _locked(network)
    if (
        budget.upload_count >= settings.MAX_UPLOADS_PER_NETWORK
        or budget.upload_bytes + size > settings.MAX_UPLOAD_BYTES_PER_NETWORK
        or budget.upload_window_count >= settings.MAX_UPLOADS_PER_NETWORK_PER_MINUTE
    ):
        return False
    budget.upload_count += 1
    budget.upload_bytes += size
    budget.upload_window_count += 1
    budget.save()
    return True
