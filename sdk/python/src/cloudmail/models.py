"""Pydantic models for the main API shapes.

Every model allows extra fields: the server adds keys over time, and a new
field must never break an older client. Shapes follow `workers/lib/openapi.ts`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Attachment(_Model):
    id: Optional[str] = None
    filename: Optional[str] = None
    mimetype: Optional[str] = None
    size: Optional[int] = None


class Email(_Model):
    id: str
    subject: str = ""
    sender: str = ""
    recipient: str = ""
    date: Optional[str] = None
    read: bool = False
    starred: bool = False
    thread_id: Optional[str] = None
    folder_id: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    body: Optional[str] = None
    snippet: Optional[str] = None
    in_reply_to: Optional[str] = None
    message_id: Optional[str] = None
    priority: Optional[str] = None
    delivery_status: Optional[str] = None
    attachments: Optional[List[Attachment]] = None
    has_attachment: Optional[bool] = None


class EmailPage(_Model):
    emails: List[Email]
    totalCount: int = 0


class Mailbox(_Model):
    id: str
    email: str
    name: str
    domain: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None


class SuppressedRecipient(_Model):
    address: Optional[str] = None
    reason: Optional[str] = None


class SendAccepted(_Model):
    id: str
    status: Literal["sent"] = "sent"
    suppressed: Optional[List[Dict[str, Any]]] = None
    suppression_warnings: Optional[List[Dict[str, Any]]] = None


class PendingApproval(_Model):
    """The send was held for a person to approve; nothing was sent. Do not retry."""

    status: Literal["pending_approval"]
    approval_id: str
    approval_url: str
    expires_at: Optional[str] = None
    reason: Optional[str] = None
    message: Optional[str] = None


SendResult = Union[SendAccepted, PendingApproval]


def is_pending_approval(result: Any) -> bool:
    """True when a send or reply was held for approval instead of sent."""
    return isinstance(result, PendingApproval)


class SendApproval(_Model):
    id: str
    kind: Optional[str] = None
    status: str
    reason: Optional[str] = None
    recipients: Optional[List[str]] = None
    subject: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None
    editable: Optional[bool] = None
    #: 1 when stored, +1 per edit or revision. Pass it to `approve` so a newer version is never sent unseen.
    revision: Optional[int] = None
    revised_at: Optional[str] = None
    #: "requester" (the agent revised its own send) or "reviewer" (a person edited it).
    revised_by: Optional[str] = None


class WebhookAttempt(_Model):
    attempt: int
    statusCode: Optional[int] = None
    durationMs: Optional[int] = None
    error: Optional[str] = None
    at: Optional[int] = None


class Webhook(_Model):
    id: str
    name: str
    url: str
    events: List[str]
    mailboxes: Optional[List[str]] = None
    enabled: bool = True
    disabledReason: Optional[str] = None
    secretHint: Optional[str] = None
    createdAt: Optional[int] = None
    updatedAt: Optional[int] = None
    consecutiveFailures: Optional[int] = None


class WebhookWithSecret(_Model):
    webhook: Webhook
    secret: Optional[str] = None


class WebhookDelivery(_Model):
    id: str
    endpointId: Optional[str] = None
    eventId: Optional[str] = None
    eventType: Optional[str] = None
    mailbox: Optional[str] = None
    status: str
    attempts: int = 0
    lastStatusCode: Optional[int] = None
    lastError: Optional[str] = None
    test: Optional[bool] = None
    attemptLog: Optional[List[WebhookAttempt]] = None


class AgentInbox(_Model):
    address: str
    purpose: Optional[str] = None
    display_name: Optional[str] = None
    send_mode: Optional[str] = None
    allowed_recipients: Optional[List[str]] = None
    token_id: Optional[str] = None
    scopes: Optional[List[str]] = None
    webhook_id: Optional[str] = None
    webhook_url: Optional[str] = None
    created_at: Optional[int] = None
    expires_at: Optional[int] = None
    expired: Optional[bool] = None


class AgentInboxToken(_Model):
    id: str
    secret: Optional[str] = None
    scopes: List[str] = []
    mailboxes: List[str] = []
    expires_at: Optional[int] = None


class AgentInboxWebhook(_Model):
    id: str
    url: str
    events: List[str] = []
    secret: Optional[str] = None


class AgentInboxCreated(_Model):
    agent_inbox: AgentInbox
    address: str
    token: AgentInboxToken
    policy: Optional[Dict[str, Any]] = None
    webhook: Optional[AgentInboxWebhook] = None
    routing: Optional[Dict[str, Any]] = None
    warnings: List[str] = []


class WebhookEvent(_Model):
    """A webhook (and event stream) payload."""

    id: str
    type: str
    created_at: str
    mailbox: str
    test: Optional[bool] = None
    data: Dict[str, Any] = {}
