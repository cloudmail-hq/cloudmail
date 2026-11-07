"""Exceptions raised by the client."""

from __future__ import annotations

import email.utils
import time
from typing import Any, Mapping, Optional


class TapetideError(Exception):
    """An error response from the API, or a failure to reach it.

    `status` is the HTTP status (None when no response arrived), `code` the
    machine-readable code from the body when there is one, `message` the
    human-readable error, and `body` the parsed response body.
    """

    def __init__(
        self,
        status: Optional[int],
        code: Optional[str],
        message: str,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.body = body
        self.headers = dict(headers) if headers is not None else None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status!r}, code={self.code!r}, message={self.message!r})"


# The product is cloudmail; this name is the stable base class for every error.
CloudmailError = TapetideError


class ValidationError(TapetideError):
    """400 or 422: the request was refused as invalid."""


class AuthenticationError(TapetideError):
    """401: missing, invalid, revoked or expired token."""


class PermissionDeniedError(TapetideError):
    """403: the grant or token scope does not allow this (`insufficient_scope`, `session_required`, ...)."""


class NotFoundError(TapetideError):
    """404."""


class ConflictError(TapetideError):
    """409: conflicts with existing state, or an Idempotency-Key was reused."""


class ApprovalChangedError(ConflictError):
    """409 from `approvals.approve`: the held send changed after you read it.

    The requester revised it (or a person edited it), so nothing was sent.
    `approval` is the current version; review it, then approve again with
    `revision=approval.revision`.
    """

    @property
    def approval(self) -> Any:
        from .models import SendApproval

        raw = self.body.get("approval") if isinstance(self.body, dict) else None
        return SendApproval.model_validate(raw) if isinstance(raw, dict) else None


class RateLimitError(TapetideError):
    """429: rate limited or over a send cap. `retry_after` is the server's hint in seconds, or None."""

    @property
    def retry_after(self) -> Optional[float]:
        return parse_retry_after((self.headers or {}).get("retry-after"))


class ServerError(TapetideError):
    """5xx. On a send this can mean the message went out, so the client does not retry it."""


class APIConnectionError(TapetideError):
    """The request could not be completed (network error or timeout) after retries."""


class WebhookVerificationError(Exception):
    """A webhook's signature or timestamp did not check out."""


def parse_retry_after(raw: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Seconds from a `Retry-After` header: delta-seconds or an HTTP date."""
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        at = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if at is None:
        return None
    return max(0.0, at.timestamp() - (time.time() if now is None else now))


_BY_STATUS = {
    400: ValidationError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: ValidationError,
    429: RateLimitError,
}


def error_for_status(status: int, body: Any, headers: Optional[Mapping[str, str]] = None) -> TapetideError:
    code = None
    message = f"HTTP {status}"
    if isinstance(body, dict):
        code = body.get("code") if isinstance(body.get("code"), str) else None
        err = body.get("error") or body.get("message")
        if isinstance(err, str) and err:
            message = err
    elif isinstance(body, str) and body.strip():
        message = body.strip()[:500]
    cls = _BY_STATUS.get(status) or (ServerError if status >= 500 else TapetideError)
    lowered = {k.lower(): v for k, v in headers.items()} if headers is not None else None
    return cls(status, code, message, body, lowered)
