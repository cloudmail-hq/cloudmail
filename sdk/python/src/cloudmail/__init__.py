"""Python client for the cloudmail API."""

from ._version import __version__
from .client import SEND_POST_PATHS, StreamEvent, StreamRevoked, Tapetide

#: The product is cloudmail; `Cloudmail` and `Tapetide` are the same client.
Cloudmail = Tapetide
from .errors import (
    APIConnectionError,
    ApprovalChangedError,
    CloudmailError,
    ServerError,
    ValidationError,
    parse_retry_after,
    AuthenticationError,
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    TapetideError,
    WebhookVerificationError,
)
from .models import (
    AgentInbox,
    AgentInboxCreated,
    Email,
    EmailPage,
    Mailbox,
    PendingApproval,
    SendAccepted,
    SendApproval,
    SendResult,
    Webhook,
    WebhookDelivery,
    WebhookEvent,
    WebhookWithSecret,
    is_pending_approval,
)
from .sse import SseFrame, SseParser, parse_sse
from .webhooks import sign_webhook, verify_webhook

__all__ = [
    "__version__",
    "Tapetide",
    "Cloudmail",
    "SEND_POST_PATHS",
    "ApprovalChangedError",
    "CloudmailError",
    "ServerError",
    "ValidationError",
    "parse_retry_after",
    "StreamEvent",
    "StreamRevoked",
    "APIConnectionError",
    "AuthenticationError",
    "ConflictError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "TapetideError",
    "WebhookVerificationError",
    "AgentInbox",
    "AgentInboxCreated",
    "Email",
    "EmailPage",
    "Mailbox",
    "PendingApproval",
    "SendAccepted",
    "SendApproval",
    "SendResult",
    "Webhook",
    "WebhookDelivery",
    "WebhookEvent",
    "WebhookWithSecret",
    "is_pending_approval",
    "SseFrame",
    "SseParser",
    "parse_sse",
    "sign_webhook",
    "verify_webhook",
]
