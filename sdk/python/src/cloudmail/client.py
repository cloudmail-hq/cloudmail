"""The HTTP client and its resource groups."""

from __future__ import annotations

import random
import re
import time
import uuid
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import httpx

from . import resources as _r
from ._version import __version__
from .errors import (
    APIConnectionError,
    ApprovalChangedError,
    ConflictError,
    TapetideError,
    error_for_status,
    parse_retry_after,
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
    WebhookWithSecret,
)
from .sse import SseFrame, SseParser

Recipients = Union[str, Sequence[str]]

RETRY_BASE_SECONDS = 0.5
RETRY_MAX_SECONDS = 8.0


def _seg(value: str) -> str:
    """One URL path segment: mailbox addresses and ids are fully encoded."""
    return quote(str(value), safe="")


def _list(value: Optional[Recipients]) -> Optional[Union[str, List[str]]]:
    if value is None or isinstance(value, str):
        return value
    return list(value)


def _clean(body: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in body.items() if v is not None}


def _retry_after(response: httpx.Response) -> Optional[float]:
    return parse_retry_after(response.headers.get("retry-after"))


#: POST routes that send or queue mail (OpenAPI templates). A 5xx or 408 from
#: one of these is not retried: the message may have gone out, and the server
#: does not keep a 5xx against the idempotency key, so a retry would send again.
SEND_POST_PATHS = (
    "/api/v1/mailboxes/{mailboxId}/emails",
    "/api/v1/mailboxes/{mailboxId}/emails/{id}/reply",
    "/api/v1/mailboxes/{mailboxId}/emails/{id}/forward",
    "/api/v1/mailboxes/{mailboxId}/scheduled-sends",
    "/api/v1/mailboxes/{mailboxId}/scheduled-sends/{emailId}/send-now",
    "/api/v1/mailboxes/{mailboxId}/template-sends",
    "/api/v1/mailboxes/{mailboxId}/approvals/{id}/approve",
    "/api/v1/sequences/{id}/enroll",
)
_SEND_RES = [re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", p) + "$") for p in SEND_POST_PATHS]

#: 503 codes the server answers before running the handler; safe to retry anywhere.
_REFUSED_BEFORE_RUNNING = {"idempotency_unavailable", "licence_unavailable"}


def _is_send(method: str, path: str) -> bool:
    return method == "POST" and any(r.match(path) for r in _SEND_RES)


class Tapetide:
    """Client for a cloudmail deployment.

    ```python
    tt = Tapetide("https://mail.example.com", token="ttk_...")
    result = tt.mail.send("support@example.com", to="a@b.com", subject="Hi", text="Hello")
    ```
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        max_retries: int = 2,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if not token:
            raise ValueError("token is required")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.max_retries = max(0, int(max_retries))
        self._sleep = sleep
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)

        self.mail = MailResource(self)
        self.mailboxes = MailboxesResource(self)
        self.agent_inboxes = AgentInboxesResource(self)
        self.webhooks = WebhooksResource(self)
        self.approvals = ApprovalsResource(self)
        self.events = EventsResource(self)

        # Inside a mailbox
        self.threads = _r.ThreadsResource(self)
        self.folders = _r.FoldersResource(self)
        self.labels = _r.LabelsResource(self)
        self.signatures = _r.SignaturesResource(self)
        self.snooze = _r.SnoozeResource(self)
        self.followups = _r.FollowupsResource(self)
        self.triage = _r.TriageResource(self)
        self.screener = _r.ScreenerResource(self)
        self.scheduled_sends = _r.ScheduledSendsResource(self)
        self.senders = _r.SendersResource(self)
        self.rules = _r.RulesResource(self)
        self.imports = _r.ImportsResource(self)
        self.delegates = _r.DelegatesResource(self)
        self.audit = _r.AuditResource(self)

        # Instance-wide
        self.meta = _r.MetaResource(self)
        self.products = _r.ProductsResource(self)
        self.people = _r.PeopleResource(self)
        self.analytics = _r.AnalyticsResource(self)
        self.templates = _r.TemplatesResource(self)
        self.sequences = _r.SequencesResource(self)
        self.suppressions = _r.SuppressionsResource(self)
        self.sending_health = _r.SendingHealthResource(self)
        self.usage = _r.UsageResource(self)
        self.domains = _r.DomainsResource(self)
        self.cloudflare = _r.CloudflareResource(self)
        self.ai = _r.AiResource(self)
        self.assistant = _r.AssistantResource(self)
        self.notifications = _r.NotificationsResource(self)
        self.preferences = _r.PreferencesResource(self)
        self.branding = _r.BrandingResource(self)
        self.access = _r.AccessResource(self)
        self.privacy = _r.PrivacyResource(self)
        self.licence = _r.LicenceResource(self)
        self.migration = _r.MigrationResource(self)

    # -- lifecycle -----------------------------------------------------------

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "Tapetide":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- transport -----------------------------------------------------------

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": f"cloudmail-python/{__version__}",
            "Accept": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    def _backoff(self, attempt: int, response: Optional[httpx.Response]) -> float:
        if response is not None:
            hinted = _retry_after(response)
            if hinted is not None:
                return min(hinted, RETRY_MAX_SECONDS)
        base = min(RETRY_BASE_SECONDS * (2**attempt), RETRY_MAX_SECONDS)
        return base / 2 + random.random() * base / 2

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json: Any = None,
        idempotency_key: Optional[str] = None,
        idempotent: bool = False,
        content: Optional[bytes] = None,
        content_type: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        retry_server_errors: Optional[bool] = None,
    ) -> httpx.Response:
        """Send a request; raise `TapetideError` on a non-2xx response.

        `idempotent=True` attaches an `Idempotency-Key` (a fresh UUID unless one
        is given). Only GETs and keyed requests are retried, on transport
        errors, 408, 429, 5xx, and `idempotency_request_in_progress`, always
        with the same key.

        Sends (`SEND_POST_PATHS`) are not retried on a 5xx or 408, because the
        message may have gone out and the server does not keep a 5xx against
        the key. A 503 the server returns before running anything
        (`idempotency_unavailable`, `licence_unavailable`) is still retried.
        `retry_server_errors` overrides that choice.

        `content` sends raw bytes (`content_type`, default
        `application/octet-stream`) instead of JSON.
        """
        method = method.upper()
        extra: Dict[str, str] = dict(headers or {})
        if idempotent or idempotency_key:
            extra["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        if content is not None:
            extra["Content-Type"] = content_type or "application/octet-stream"
        retryable = method == "GET" or "Idempotency-Key" in extra
        if retry_server_errors is None:
            retry_server_errors = not _is_send(method, path)
        url = f"{self.base_url}{path}"
        query = {k: v for k, v in (params or {}).items() if v is not None}
        all_headers = self._headers(extra)

        attempt = 0
        while True:
            try:
                response = self._http.request(
                    method, url, params=query or None, json=json, content=content, headers=all_headers
                )
            except httpx.TransportError as exc:
                if retryable and attempt < self.max_retries:
                    self._sleep(self._backoff(attempt, None))
                    attempt += 1
                    continue
                raise APIConnectionError(None, "connection_error", str(exc) or type(exc).__name__) from exc

            if response.is_success:
                return response
            body = _body(response)
            status = response.status_code
            code = body.get("code") if isinstance(body, dict) else None
            in_progress = status == 409 and code == "idempotency_request_in_progress"
            may_have_run = status >= 500 or status == 408
            refused_before_running = status == 503 and code in _REFUSED_BEFORE_RUNNING
            status_retryable = (status in (408, 429) or status >= 500) and (
                not may_have_run or retry_server_errors or refused_before_running
            )
            if retryable and attempt < self.max_retries and (status_retryable or in_progress):
                self._sleep(self._backoff(attempt, response))
                attempt += 1
                continue
            raise error_for_status(status, body, response.headers)

    def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self.request(method, path, **kwargs)
        return _body(response)

    def _download(
        self, path: str, *, params: Optional[Mapping[str, Any]] = None, dest: Optional[Any] = None
    ) -> Optional[bytes]:
        """GET a binary resource. Returns the bytes, or streams them into `dest` (a binary file) and returns None.

        Raises `TapetideError` on a non-2xx. Transport errors before the body starts are retried.
        """
        url = f"{self.base_url}{path}"
        query = {k: v for k, v in (params or {}).items() if v is not None}
        headers = self._headers({"Accept": "*/*"})
        attempt = 0
        while True:
            try:
                with self._http.stream("GET", url, params=query or None, headers=headers) as response:
                    if not response.is_success:
                        response.read()
                        if response.status_code >= 500 and attempt < self.max_retries:
                            self._sleep(self._backoff(attempt, response))
                            attempt += 1
                            continue
                        raise error_for_status(response.status_code, _body(response), response.headers)
                    if dest is None:
                        return response.read()
                    for chunk in response.iter_bytes():
                        dest.write(chunk)
                    return None
            except httpx.TransportError as exc:
                if attempt < self.max_retries:
                    self._sleep(self._backoff(attempt, None))
                    attempt += 1
                    continue
                raise APIConnectionError(None, "connection_error", str(exc) or type(exc).__name__) from exc


def _body(response: httpx.Response) -> Any:
    if response.status_code == 204 or not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _send_result(body: Any) -> SendResult:
    if isinstance(body, dict) and body.get("status") == "pending_approval":
        return PendingApproval.model_validate(body)
    return SendAccepted.model_validate(body)


def _email_page(body: Any) -> EmailPage:
    if isinstance(body, list):
        return EmailPage(emails=[Email.model_validate(e) for e in body], totalCount=len(body))
    return EmailPage.model_validate(body)


class _Resource:
    def __init__(self, client: Tapetide) -> None:
        self._client = client


def _mb(mailbox: str) -> str:
    return f"/api/v1/mailboxes/{_seg(mailbox)}"


class MailResource(_Resource):
    def _message(
        self,
        mailbox: str,
        *,
        to: Recipients,
        subject: str,
        html: Optional[str],
        text: Optional[str],
        cc: Optional[Recipients],
        bcc: Optional[Recipients],
        from_: Optional[Union[str, Mapping[str, str]]],
        attachments: Optional[Sequence[Mapping[str, Any]]],
        extra: Mapping[str, Any],
    ) -> Dict[str, Any]:
        if html is None and text is None:
            raise ValueError("html or text is required")
        body = _clean(
            {
                "to": _list(to),
                "cc": _list(cc),
                "bcc": _list(bcc),
                "from": dict(from_) if isinstance(from_, Mapping) else (from_ or mailbox),
                "subject": subject,
                "html": html,
                "text": text,
                "attachments": [dict(a) for a in attachments] if attachments is not None else None,
            }
        )
        body.update(_clean(extra))
        return body

    def send(
        self,
        mailbox: str,
        *,
        to: Recipients,
        subject: str,
        html: Optional[str] = None,
        text: Optional[str] = None,
        cc: Optional[Recipients] = None,
        bcc: Optional[Recipients] = None,
        from_: Optional[Union[str, Mapping[str, str]]] = None,
        attachments: Optional[Sequence[Mapping[str, Any]]] = None,
        idempotency_key: Optional[str] = None,
        **extra: Any,
    ) -> SendResult:
        """Send now. Returns `SendAccepted`, or `PendingApproval` when held for a person."""
        body = self._message(
            mailbox, to=to, subject=subject, html=html, text=text, cc=cc, bcc=bcc,
            from_=from_, attachments=attachments, extra=extra,
        )
        return _send_result(
            self._client._json("POST", f"{_mb(mailbox)}/emails", json=body, idempotent=True, idempotency_key=idempotency_key)
        )

    def reply(
        self,
        mailbox: str,
        email_id: str,
        *,
        to: Recipients,
        subject: str,
        html: Optional[str] = None,
        text: Optional[str] = None,
        cc: Optional[Recipients] = None,
        bcc: Optional[Recipients] = None,
        from_: Optional[Union[str, Mapping[str, str]]] = None,
        attachments: Optional[Sequence[Mapping[str, Any]]] = None,
        idempotency_key: Optional[str] = None,
        **extra: Any,
    ) -> SendResult:
        """Reply to a message; threading headers are derived server-side."""
        body = self._message(
            mailbox, to=to, subject=subject, html=html, text=text, cc=cc, bcc=bcc,
            from_=from_, attachments=attachments, extra=extra,
        )
        path = f"{_mb(mailbox)}/emails/{_seg(email_id)}/reply"
        return _send_result(self._client._json("POST", path, json=body, idempotent=True, idempotency_key=idempotency_key))

    def forward(
        self,
        mailbox: str,
        email_id: str,
        *,
        to: Recipients,
        subject: str,
        html: Optional[str] = None,
        text: Optional[str] = None,
        cc: Optional[Recipients] = None,
        bcc: Optional[Recipients] = None,
        from_: Optional[Union[str, Mapping[str, str]]] = None,
        attachments: Optional[Sequence[Mapping[str, Any]]] = None,
        idempotency_key: Optional[str] = None,
        **extra: Any,
    ) -> SendResult:
        body = self._message(
            mailbox, to=to, subject=subject, html=html, text=text, cc=cc, bcc=bcc,
            from_=from_, attachments=attachments, extra=extra,
        )
        path = f"{_mb(mailbox)}/emails/{_seg(email_id)}/forward"
        return _send_result(self._client._json("POST", path, json=body, idempotent=True, idempotency_key=idempotency_key))

    def list(
        self,
        mailbox: str,
        *,
        folder: str = "inbox",
        page: Optional[int] = None,
        limit: Optional[int] = None,
        unread: Optional[bool] = None,
        starred: Optional[bool] = None,
        threaded: Optional[bool] = None,
        **params: Any,
    ) -> EmailPage:
        query = {
            "folder": folder,
            "page": page,
            "limit": limit,
            "unread": _flag(unread),
            "starred": _flag(starred),
            "threaded": _flag(threaded),
            **params,
        }
        return _email_page(self._client._json("GET", f"{_mb(mailbox)}/emails", params=query))

    def get(self, mailbox: str, email_id: str) -> Email:
        return Email.model_validate(self._client._json("GET", f"{_mb(mailbox)}/emails/{_seg(email_id)}"))

    def search(
        self,
        mailbox: str,
        query: str,
        *,
        folder: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
        mode: Optional[str] = None,
    ) -> EmailPage:
        params = {"query": query, "folder": folder, "page": page, "limit": limit, "mode": mode}
        return _email_page(self._client._json("GET", f"{_mb(mailbox)}/search", params=params))

    def update(self, mailbox: str, email_id: str, *, read: Optional[bool] = None, starred: Optional[bool] = None) -> Email:
        """updateEmail: mark read or unread, star or unstar."""
        body = _clean({"read": read, "starred": starred})
        return Email.model_validate(self._client._json("PUT", f"{_mb(mailbox)}/emails/{_seg(email_id)}", json=body))

    def delete(self, mailbox: str, email_id: str, *, permanent: bool = False) -> None:
        """deleteEmail: move to trash, or delete for good with `permanent=True`."""
        params = {"permanent": "true" if permanent else None}
        self._client.request("DELETE", f"{_mb(mailbox)}/emails/{_seg(email_id)}", params=params)

    def restore(self, mailbox: str, email_id: str) -> Dict[str, Any]:
        """restoreEmail: take a message back out of trash."""
        return self._client._json("POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/restore")

    def move(self, mailbox: str, email_id: str, folder_id: str) -> Dict[str, Any]:
        """moveEmail."""
        return self._client._json("POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/move", json={"folderId": folder_id})

    def set_priority(self, mailbox: str, email_id: str, priority: str) -> Email:
        """setEmailPriority."""
        body = self._client._json("PUT", f"{_mb(mailbox)}/emails/{_seg(email_id)}/priority", json={"priority": priority})
        return Email.model_validate(body)

    def not_spam(self, mailbox: str, email_id: str) -> Dict[str, Any]:
        """markNotSpam."""
        return self._client._json("POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/not-spam")

    def delivery_events(self, mailbox: str, email_id: str) -> List[Dict[str, Any]]:
        """listDeliveryEvents: delivery, bounce, open and click events for a sent message."""
        body = self._client._json("GET", f"{_mb(mailbox)}/emails/{_seg(email_id)}/delivery-events")
        return list((body or {}).get("events", []))

    def attachment(
        self, mailbox: str, email_id: str, attachment_id: str, *, disposition: Optional[str] = None, dest: Optional[Any] = None
    ) -> Optional[bytes]:
        """getAttachment: the bytes, or streamed into the binary file `dest`."""
        path = f"{_mb(mailbox)}/emails/{_seg(email_id)}/attachments/{_seg(attachment_id)}"
        return self._client._download(path, params={"disposition": disposition}, dest=dest)

    def bulk(self, mailbox: str, action: str, ids: Sequence[str], **fields: Any) -> Dict[str, Any]:
        """bulkEmailAction: one action (read, unread, star, move, label, trash, delete, ...) on many messages."""
        body = _clean({"action": action, "ids": list(ids), **fields})
        return self._client._json("POST", f"{_mb(mailbox)}/emails/bulk", json=body)

    def empty_trash(self, mailbox: str) -> Dict[str, Any]:
        """emptyTrash."""
        return self._client._json("POST", f"{_mb(mailbox)}/trash/empty")

    def mark_all_read(self, mailbox: str, *, folder: Optional[str] = None, label_id: Optional[str] = None) -> Dict[str, Any]:
        """markAllRead."""
        return self._client._json("POST", f"{_mb(mailbox)}/mark-all-read", json=_clean({"folder": folder, "label_id": label_id}))

    def save_draft(self, mailbox: str, *, body: str, idempotency_key: Optional[str] = None, **fields: Any) -> Dict[str, Any]:
        """saveDraft: create a draft, or update one with `draft_id=`."""
        payload = _clean({"body": body, **fields})
        return self._client._json(
            "POST", f"{_mb(mailbox)}/drafts", json=payload, idempotent=True, idempotency_key=idempotency_key
        )

    def search_all(self, q: str, **params: Any) -> Dict[str, Any]:
        """searchAllMailboxes: `mode`, `mailbox`, `product`, `folder`, `limit`."""
        return self._client._json("GET", "/api/v1/search", params={"q": q, **params})

    def ask(self, question: str, *, mailbox: Optional[str] = None, product: Optional[str] = None) -> Dict[str, Any]:
        """askInbox: ask a question about your mail; the answer cites messages."""
        body = _clean({"question": question, "mailbox": mailbox, "product": product})
        return self._client._json("POST", "/api/v1/ask", json=body)

    def unified(self, *, cursor: Optional[str] = None, **params: Any) -> Dict[str, Any]:
        """listUnifiedInbox: one page across mailboxes. Pass `nextCursor` back as `cursor`."""
        query = {k: _flag(v) if isinstance(v, bool) else v for k, v in params.items()}
        return self._client._json("GET", "/api/v1/inbox", params={"cursor": cursor, **query})

    def iter_unified(self, **params: Any) -> Iterator[Dict[str, Any]]:
        """Every message across mailboxes, following `nextCursor`."""
        cursor = params.pop("cursor", None)
        while True:
            page = self.unified(cursor=cursor, **params)
            yield from page.get("emails", [])
            cursor = page.get("nextCursor")
            if not cursor:
                return


def _flag(value: Optional[bool]) -> Optional[str]:
    return None if value is None else ("true" if value else "false")


class MailboxesResource(_Resource):
    def list(self, *, domain: Optional[str] = None, include_settings: bool = False) -> List[Mailbox]:
        params = {"domain": domain, "include": "settings" if include_settings else None}
        return [Mailbox.model_validate(m) for m in self._client._json("GET", "/api/v1/mailboxes", params=params)]

    def get(self, mailbox: str) -> Mailbox:
        return Mailbox.model_validate(self._client._json("GET", _mb(mailbox)))

    def create(
        self,
        email: str,
        name: str,
        *,
        settings: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Mailbox:
        body = _clean({"email": email, "name": name, "settings": dict(settings) if settings else None})
        return Mailbox.model_validate(
            self._client._json("POST", "/api/v1/mailboxes", json=body, idempotent=True, idempotency_key=idempotency_key)
        )

    def update(self, mailbox: str, settings: Mapping[str, Any]) -> Mailbox:
        return Mailbox.model_validate(self._client._json("PUT", _mb(mailbox), json={"settings": dict(settings)}))

    def delete(self, mailbox: str) -> None:
        self._client.request("DELETE", _mb(mailbox))

    def state(self, mailbox: str) -> Dict[str, Any]:
        """getMailboxState: folder counts and other live state."""
        return self._client._json("GET", f"{_mb(mailbox)}/state")

    def aliases(self, mailbox: str) -> List[Any]:
        """listMailboxAliases."""
        return list((self._client._json("GET", f"{_mb(mailbox)}/aliases") or {}).get("aliases", []))

    def set_aliases(self, mailbox: str, aliases: Sequence[Any]) -> List[Any]:
        """setMailboxAliases."""
        body = self._client._json("PUT", f"{_mb(mailbox)}/aliases", json={"aliases": list(aliases)})
        return list((body or {}).get("aliases", []))

    def export(self, mailbox: str, *, dest: Optional[Any] = None) -> Optional[bytes]:
        """exportMailbox: every message as mbox. Pass a binary file as `dest` to stream it."""
        return self._client._download(f"{_mb(mailbox)}/export", dest=dest)


class AgentInboxesResource(_Resource):
    def create(
        self,
        *,
        domain: str,
        purpose: str,
        send_mode: str,
        local_part: Optional[str] = None,
        ttl_hours: Optional[float] = None,
        allowed_recipients: Optional[Sequence[str]] = None,
        webhook_url: Optional[str] = None,
        display_name: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> AgentInboxCreated:
        """Create a mailbox for an agent with a scoped token. Secrets are returned once."""
        body = _clean(
            {
                "domain": domain,
                "purpose": purpose,
                "send_mode": send_mode,
                "local_part": local_part,
                "ttl_hours": ttl_hours,
                "allowed_recipients": list(allowed_recipients) if allowed_recipients is not None else None,
                "webhook_url": webhook_url,
                "display_name": display_name,
            }
        )
        return AgentInboxCreated.model_validate(
            self._client._json("POST", "/api/v1/agent-inboxes", json=body, idempotent=True, idempotency_key=idempotency_key)
        )

    def list(self) -> List[AgentInbox]:
        body = self._client._json("GET", "/api/v1/agent-inboxes")
        return [AgentInbox.model_validate(a) for a in (body or {}).get("agent_inboxes", [])]

    def get(self, address: str) -> AgentInbox:
        body = self._client._json("GET", f"/api/v1/agent-inboxes/{_seg(address)}")
        return AgentInbox.model_validate(body["agent_inbox"])

    def update(self, address: str, *, allowed_recipients: Optional[Sequence[str]]) -> AgentInbox:
        """Change or clear the optional recipient restriction.

        ``None`` (the default state) lets the inbox send to anyone; a list restricts
        it to those addresses and ``@domain``s, and anyone else is refused.
        """
        body = self._client._json(
            "PATCH",
            f"/api/v1/agent-inboxes/{_seg(address)}",
            json={"allowed_recipients": list(allowed_recipients) if allowed_recipients is not None else None},
        )
        return AgentInbox.model_validate(body["agent_inbox"])

    def delete(self, address: str) -> Dict[str, Any]:
        body = self._client._json("DELETE", f"/api/v1/agent-inboxes/{_seg(address)}")
        return (body or {}).get("ended", body or {})


class WebhooksResource(_Resource):
    def list(self) -> List[Webhook]:
        body = self._client._json("GET", "/api/v1/webhooks")
        return [Webhook.model_validate(w) for w in (body or {}).get("webhooks", [])]

    def create(
        self,
        *,
        name: str,
        url: str,
        events: Sequence[str],
        mailboxes: Optional[Sequence[str]] = None,
        enabled: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
    ) -> WebhookWithSecret:
        """Create an endpoint. `secret` (whsec_…) is returned once; store it."""
        body = _clean(
            {
                "name": name,
                "url": url,
                "events": list(events),
                "mailboxes": list(mailboxes) if mailboxes is not None else None,
                "enabled": enabled,
            }
        )
        return WebhookWithSecret.model_validate(
            self._client._json("POST", "/api/v1/webhooks", json=body, idempotent=True, idempotency_key=idempotency_key)
        )

    def get(self, webhook_id: str) -> Webhook:
        return Webhook.model_validate(self._client._json("GET", f"/api/v1/webhooks/{_seg(webhook_id)}")["webhook"])

    def update(self, webhook_id: str, **fields: Any) -> Webhook:
        body = self._client._json("PATCH", f"/api/v1/webhooks/{_seg(webhook_id)}", json=fields)
        return Webhook.model_validate(body["webhook"])

    def delete(self, webhook_id: str) -> None:
        self._client.request("DELETE", f"/api/v1/webhooks/{_seg(webhook_id)}")

    def rotate_secret(self, webhook_id: str) -> WebhookWithSecret:
        return WebhookWithSecret.model_validate(
            self._client._json("POST", f"/api/v1/webhooks/{_seg(webhook_id)}/rotate-secret")
        )

    def test(self, webhook_id: str) -> Optional[WebhookDelivery]:
        body = self._client._json("POST", f"/api/v1/webhooks/{_seg(webhook_id)}/test")
        delivery = (body or {}).get("delivery")
        return WebhookDelivery.model_validate(delivery) if delivery else None

    def deliveries(self, webhook_id: str, *, limit: Optional[int] = None) -> List[WebhookDelivery]:
        body = self._client._json("GET", f"/api/v1/webhooks/{_seg(webhook_id)}/deliveries", params={"limit": limit})
        return [WebhookDelivery.model_validate(d) for d in (body or {}).get("deliveries", [])]

    def replace(self, webhook_id: str, **fields: Any) -> Webhook:
        """replaceWebhookFields (PUT): set the given fields, as `update` does."""
        body = self._client._json("PUT", f"/api/v1/webhooks/{_seg(webhook_id)}", json=fields)
        return Webhook.model_validate(body["webhook"])

    def event_types(self) -> Dict[str, Any]:
        """listWebhookEvents: the event types a webhook can subscribe to, and the retry schedule."""
        return self._client._json("GET", "/api/v1/webhooks/events")

    def retry_delivery(self, delivery_id: str) -> Optional[WebhookDelivery]:
        """retryWebhookDelivery: deliver a past delivery's event again."""
        body = self._client._json("POST", f"/api/v1/webhooks/deliveries/{_seg(delivery_id)}/retry")
        delivery = (body or {}).get("delivery")
        return WebhookDelivery.model_validate(delivery) if delivery else None


class ApprovalsResource(_Resource):
    def list(self, mailbox: str, *, status: Optional[str] = None, limit: Optional[int] = None) -> List[SendApproval]:
        body = self._client._json("GET", f"{_mb(mailbox)}/approvals", params={"status": status, "limit": limit})
        return [SendApproval.model_validate(a) for a in (body or {}).get("approvals", [])]

    def count(self, mailbox: str) -> int:
        return int((self._client._json("GET", f"{_mb(mailbox)}/approvals/count") or {}).get("pending", 0))

    def get(self, mailbox: str, approval_id: str) -> SendApproval:
        body = self._client._json("GET", f"{_mb(mailbox)}/approvals/{_seg(approval_id)}")
        return SendApproval.model_validate(body["approval"])

    def approve(
        self,
        mailbox: str,
        approval_id: str,
        *,
        revision: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Approve and send a held message, at most once. Returns `{approval, result}`.

        Pass `revision` (from `get`) so a send that changed after you read it is
        refused: that 409 raises `ApprovalChangedError`, whose `approval` is the
        new version, and nothing was sent. Transport errors are retried with the
        same key; a 5xx is not (a 502 means it may have been sent).
        """
        try:
            body = self._client._json(
                "POST",
                f"{_mb(mailbox)}/approvals/{_seg(approval_id)}/approve",
                json={"revision": revision} if revision is not None else None,
                idempotent=True,
                idempotency_key=idempotency_key,
                retry_server_errors=False,
            )
        except ConflictError as err:
            current = err.body.get("approval") if isinstance(err.body, dict) else None
            # 409 with a still-pending approval: it changed. A decided one is "already sent".
            if isinstance(current, dict) and current.get("status") == "pending":
                raise ApprovalChangedError(err.status, err.code, err.message, err.body, err.headers) from err
            raise
        out = dict(body or {})
        if "approval" in out:
            out["approval"] = SendApproval.model_validate(out["approval"])
        return out

    def edit(
        self,
        mailbox: str,
        approval_id: str,
        *,
        to: Optional[Recipients] = None,
        cc: Optional[Recipients] = None,
        subject: Optional[str] = None,
        html: Optional[str] = None,
    ) -> SendApproval:
        """A reviewer edits a pending single message before approving (PATCH). Raises `revision`."""
        body = _clean({"to": _list(to), "cc": _list(cc), "subject": subject, "html": html})
        out = self._client._json("PATCH", f"{_mb(mailbox)}/approvals/{_seg(approval_id)}", json=body)
        return SendApproval.model_validate(out["approval"])

    def revise(
        self,
        mailbox: str,
        approval_id: str,
        *,
        to: Optional[Recipients] = None,
        cc: Optional[Recipients] = None,
        subject: Optional[str] = None,
        html: Optional[str] = None,
    ) -> SendApproval:
        """The requester revises its own pending send.

        Only the token or app that got `pending_approval` may (others get 403).
        It stays pending, `revision` goes up and `revised_by` is `requester`; a
        person still approves it. A decided approval answers 409.
        """
        body = _clean({"to": _list(to), "cc": _list(cc), "subject": subject, "html": html})
        out = self._client._json("POST", f"{_mb(mailbox)}/approvals/{_seg(approval_id)}/revise", json=body)
        return SendApproval.model_validate(out["approval"])

    def wait_for_decision(
        self,
        mailbox: str,
        approval_id: str,
        *,
        interval: float = 5.0,
        timeout: float = 600.0,
    ) -> SendApproval:
        """Poll `get` until the approval leaves `pending`, or `timeout` seconds pass (then return it still pending)."""
        deadline = time.monotonic() + timeout
        while True:
            approval = self.get(mailbox, approval_id)
            if approval.status != "pending" or time.monotonic() >= deadline:
                return approval
            self._client._sleep(interval)

    def reject(self, mailbox: str, approval_id: str, *, note: Optional[str] = None) -> SendApproval:
        body = self._client._json(
            "POST", f"{_mb(mailbox)}/approvals/{_seg(approval_id)}/reject", json=_clean({"note": note})
        )
        return SendApproval.model_validate(body["approval"])

    def retry(self, mailbox: str, approval_id: str) -> SendApproval:
        body = self._client._json("POST", f"{_mb(mailbox)}/approvals/{_seg(approval_id)}/retry")
        return SendApproval.model_validate(body["approval"])


class StreamEvent:
    """One event from the stream: `id` is the cursor, `event` the webhook payload."""

    __slots__ = ("id", "type", "event")

    def __init__(self, id: int, type: str, event: Any) -> None:
        self.id = id
        self.type = type
        self.event = event

    def __repr__(self) -> str:
        return f"StreamEvent(id={self.id!r}, type={self.type!r})"


class StreamRevoked(TapetideError):
    """The stream's credential was revoked or expired (or the server refused it)."""


class EventsResource(_Resource):
    def iter_sse(
        self,
        *,
        mailboxes: Optional[Sequence[str]] = None,
        events: Optional[Sequence[str]] = None,
        since: Optional[int] = None,
        max_reconnects: Optional[int] = None,
        on_control: Optional[Callable[[SseFrame], None]] = None,
    ) -> Iterator[StreamEvent]:
        """Yield events from `GET /api/v1/events/sse`, reconnecting with the last id.

        Reconnects on network errors, server closes, 5xx and `auth_unavailable`
        / `reauthenticate` / `replay_truncated`. Stops (raising
        `StreamRevoked`) on `credential_revoked`, 401 or 403, since a retry
        cannot fix those. `subscription_revoked` is passed to `on_control` and
        the stream continues for the other mailboxes.
        """
        client = self._client
        cursor = since
        reconnects = 0
        while True:
            params: List[tuple] = []
            for m in mailboxes or []:
                params.append(("mailbox", m))
            for e in events or []:
                params.append(("event", e))
            if cursor is not None:
                params.append(("since", str(cursor)))
            headers = client._headers({"Accept": "text/event-stream"})
            if cursor is not None:
                headers["Last-Event-ID"] = str(cursor)
            try:
                with client._http.stream(
                    "GET", f"{client.base_url}/api/v1/events/sse", params=params, headers=headers,
                    timeout=httpx.Timeout(30.0, read=None),
                ) as response:
                    if response.status_code in (401, 403):
                        response.read()
                        err = error_for_status(response.status_code, _body(response))
                        raise StreamRevoked(err.status, err.code, err.message, err.body)
                    if not response.is_success and response.status_code < 500:
                        response.read()
                        raise error_for_status(response.status_code, _body(response))
                    if response.is_success:
                        reconnects = 0
                        parser = SseParser()
                        for line in response.iter_lines():
                            frame = parser.feed_line(line)
                            if frame is None:
                                continue
                            if frame.is_control:
                                if on_control:
                                    on_control(frame)
                                if frame.event == "credential_revoked":
                                    raise StreamRevoked(401, "credential_revoked", "The token was revoked or expired")
                                data = frame.json()
                                if frame.event == "replay_truncated" and isinstance(data, dict):
                                    resume = data.get("resume_from")
                                    if isinstance(resume, int):
                                        cursor = resume
                                if frame.event in ("auth_unavailable", "reauthenticate", "replay_truncated"):
                                    break
                                continue
                            if frame.id is None:
                                continue
                            try:
                                event_id = int(frame.id)
                            except ValueError:
                                continue
                            cursor = event_id
                            yield StreamEvent(event_id, frame.event, frame.json())
            except httpx.TransportError:
                pass  # dropped connection: reconnect from the cursor
            reconnects += 1
            if max_reconnects is not None and reconnects > max_reconnects:
                return
            client._sleep(client._backoff(min(reconnects - 1, 4), None))
