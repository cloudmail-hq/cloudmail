"""Webhook signature verification.

The scheme (see `shared/webhooks.ts` on the server):

- `X-Tapetide-Timestamp`: unix seconds when the delivery was signed.
- `X-Tapetide-Signature`: `v1=<hex hmac-sha256(secret, f"{timestamp}.{body}")>`.
  The key is the whole secret string, `whsec_` prefix included. The header may
  carry several comma-separated signatures (for example during a rotation).

The timestamp is inside the MAC, so a captured request cannot be replayed with
a fresh header; checking it is recent bounds the replay window.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping, Optional, Union

from .errors import WebhookVerificationError

SIGNATURE_VERSION = "v1"
DEFAULT_TOLERANCE_SECONDS = 300
SIGNATURE_HEADER = "x-tapetide-signature"
TIMESTAMP_HEADER = "x-tapetide-timestamp"


def sign_webhook(secret: str, timestamp: int, body: Union[str, bytes]) -> str:
    """The signature header value the server sends for this body."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    message = f"{timestamp}.".encode("utf-8") + raw
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"{SIGNATURE_VERSION}={digest}"


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    # Works for plain dicts and for the header objects of httpx, Starlette,
    # Werkzeug and Django, which all expose `items()`.
    for key, value in headers.items():
        if str(key).lower() == name:
            return str(value)
    return None


def verify_webhook(
    raw_body: Union[str, bytes],
    headers: Mapping[str, Any],
    secret: str,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[float] = None,
) -> Any:
    """Check a delivery and return its parsed JSON payload.

    Pass the body exactly as received (bytes are best): re-serialising parsed
    JSON changes the bytes and breaks the signature. Raises
    `WebhookVerificationError` on a missing header, a stale timestamp, or a
    signature that does not match.
    """
    if not secret:
        raise WebhookVerificationError("No webhook secret configured")
    signature = _header(headers, SIGNATURE_HEADER)
    timestamp = _header(headers, TIMESTAMP_HEADER)
    if not signature:
        raise WebhookVerificationError("Missing X-Tapetide-Signature header")
    if not timestamp:
        raise WebhookVerificationError("Missing X-Tapetide-Timestamp header")
    try:
        ts = int(timestamp.strip())
    except ValueError:
        raise WebhookVerificationError("Invalid X-Tapetide-Timestamp header") from None
    current = time.time() if now is None else now
    if abs(current - ts) > tolerance:
        raise WebhookVerificationError("Timestamp outside the allowed tolerance")

    raw = raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)
    expected = sign_webhook(secret, ts, raw)
    candidates = [part.strip() for part in signature.split(",")]
    if not any(hmac.compare_digest(c.encode("utf-8"), expected.encode("utf-8")) for c in candidates):
        raise WebhookVerificationError("Signature mismatch")
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except ValueError:
        raise WebhookVerificationError("Body is not valid JSON") from None
