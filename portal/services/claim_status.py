"""The status a claim shows, to operators and to its participant.

One rule decides it: the claim's processing state until a Finance delivery exists, then
the delivery's state, while a claim being deleted shows that instead. The rule is a
database expression, so the admin list, its Status filter, `claim_status` and the
participant's Received page all read the same value.
"""

from dataclasses import dataclass

from django.db.models import Case, F, Q, When
from django.utils import timezone

from portal.models import Claim
from portal.services.transport import (
    ACCEPTED,
    DELIVERED,
    FAILED,
    PAUSED,
    PENDING,
    SENDING,
    UNKNOWN,
)

DELIVERY_LABELS = {
    PENDING: "Waiting to send",
    SENDING: "Sending",
    ACCEPTED: "Accepted by the email service",
    PAUSED: "Sending delayed",
    DELIVERED: "Delivered",
    FAILED: "Sending failed",
    UNKNOWN: "Delivery unclear",
}
LABELS = {**dict(Claim.State.choices), **DELIVERY_LABELS}
TONES = {
    Claim.State.FAILED: "destructive",
    Claim.State.PURGING: "outline",
    PAUSED: "warning",
    UNKNOWN: "warning",
    FAILED: "destructive",
    DELIVERED: "success",
}
# A deleted claim is gone; one still being deleted is left to the worker's cleanup.
DELETED = frozenset({Claim.State.PURGING})
# Every status in the order a claim passes through them, for filter options.
CHOICES = [
    *((state, LABELS[state]) for state in Claim.State if state not in DELETED),
    *DELIVERY_LABELS.items(),
    *((state, LABELS[state]) for state in Claim.State if state in DELETED),
]

# What a participant sees: three outcomes; the detailed states stay internal.
PROCESSING, PROBLEM = "processing", "problem"
PROBLEMS = frozenset({Claim.State.FAILED, FAILED})


def annotate(claims):
    """`claims` with each claim's `status` code."""
    shows_claim_state = Q(state=Claim.State.PURGING) | Q(delivery__isnull=True)
    return claims.annotate(
        status=Case(When(shows_claim_state, then=F("state")), default=F("delivery__state"))
    )


@dataclass(frozen=True)
class Status:
    code: str
    error_code: str
    # Unresolved past its resolution date: neither delivered nor being deleted.
    overdue: bool

    @property
    def label(self):
        return LABELS.get(self.code, self.code)

    @property
    def tone(self):
        return TONES.get(self.code, "secondary")

    @property
    def deleted(self):
        return self.code in DELETED

    @property
    def outcome(self):
        """The participant's view: processing, problem or delivered."""
        if self.code == DELIVERED:
            return DELIVERED
        return PROBLEM if self.code in PROBLEMS else PROCESSING

    @property
    def final(self):
        """The participant's view cannot change any more."""
        return self.outcome != PROCESSING


def of(claim, *, now=None):
    """The status of a claim from `annotate`; any other claim costs one query."""
    code = getattr(claim, "status", None)
    if code is None:
        code = annotate(Claim.objects.filter(pk=claim.pk)).values_list("status", flat=True).get()
    delivery = getattr(claim, "delivery", None)
    purging = claim.state == Claim.State.PURGING
    return Status(
        code=code,
        error_code=claim.error_code or (delivery.error_code if delivery else ""),
        overdue=claim.resolution_due <= (now or timezone.now())
        and not claim.retention_due
        and not purging,
    )
