"""Allocate readable references once, within the claim's acceptance transaction."""

from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify

from portal.models import ClaimReferenceCounter


@transaction.atomic
def allocate_reference(form_slug, full_name, submitted_at):
    ClaimReferenceCounter.objects.get_or_create(pk=1)
    counter = ClaimReferenceCounter.objects.select_for_update().get(pk=1)
    counter.value += 1
    counter.save(update_fields=["value"])
    surname = slugify(full_name.split()[-1], allow_unicode=True)[:60] or "name"
    date = timezone.localtime(submitted_at).date().isoformat()
    return f"Erst/{date}/{form_slug}/{surname}/{counter.value:06d}"
