"""The participant behind a request: their session binding and client network.

Drafts, uploads and submissions take a Participant rather than the Django request, so
their interface is domain values. `RequestParticipant` is the adapter for a request; tests
use their own. A Participant offers:

- `network`: the client network that shares one admission budget (`client_network`).
- `binding(create=False)`: a salted binding of the browser session, or None without one.
  `create=True` starts a session first. A started session must persist even when later
  admission fails, so never ask for one inside a transaction that can roll back.
- `remembered(form_slug)` / `remember(form_slug, draft_id, token)`: the draft this browser
  works on for a form, as `(draft_id, token)` or None.
"""

from ipaddress import ip_address, ip_network

from django.conf import settings
from django.utils.crypto import salted_hmac


def client_network(request):
    """Trust forwarding only through explicitly configured proxy networks."""
    try:
        peer = ip_address(request.META.get("REMOTE_ADDR", ""))
    except ValueError:
        return "unknown"
    proxies = [ip_network(value) for value in settings.TRUSTED_PROXY_CIDRS]
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if any(peer in network for network in proxies) and len(forwarded) <= 1024:
        try:
            chain = [ip_address(value.strip()) for value in forwarded.split(",")]
        except ValueError:
            chain = []
        for address in reversed(chain):
            if not any(peer in network for network in proxies):
                break
            peer = address
    if peer.version == 6 and peer.ipv4_mapped:
        peer = peer.ipv4_mapped
    # An IPv6 site (/48) shares one budget: a single customer or tunnel gets
    # thousands of /64s, which would otherwise count as separate networks.
    return str(ip_network(f"{peer}/{48 if peer.version == 6 else 32}", strict=False))


class RequestParticipant:
    def __init__(self, request):
        self._session = request.session
        self.network = client_network(request)

    def binding(self, *, create=False):
        if not self._session.session_key:
            if not create:
                return None
            self._session.create()
        return salted_hmac("draft-session", self._session.session_key).hexdigest()

    def remembered(self, form_slug):
        value = self._session.get(f"draft:{form_slug}") or {}
        return (value["id"], value["token"]) if value.get("id") else None

    def remember(self, form_slug, draft_id, token):
        self._session[f"draft:{form_slug}"] = {"id": str(draft_id), "token": token}
