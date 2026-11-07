"""Resource groups for the rest of the REST API.

Each method calls one OpenAPI operation (named in its docstring) and returns
the decoded JSON body as plain dicts and lists, so a field the server adds
later is never lost. Bodies with many optional fields are taken as keyword
arguments and sent as given; `None` values are dropped.

Writes the server keys (sends and creates) take `idempotency_key=` and are
retried with the same key; other writes are never retried.
"""

from __future__ import annotations

from typing import IO, TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote

if TYPE_CHECKING:  # pragma: no cover
    from .client import Tapetide

Json = Any


def _seg(value: Any) -> str:
    return quote(str(value), safe="")


def _clean(body: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in body.items() if v is not None}


def _flag(value: Optional[bool]) -> Optional[str]:
    return None if value is None else ("true" if value else "false")


def _mb(mailbox: str) -> str:
    return f"/api/v1/mailboxes/{_seg(mailbox)}"


class _Base:
    def __init__(self, client: "Tapetide") -> None:
        self._client = client

    def _get(self, path: str, **params: Any) -> Json:
        return self._client._json("GET", path, params=params or None)

    def _send(self, method: str, path: str, body: Any = None, **kwargs: Any) -> Json:
        return self._client._json(method, path, json=body, **kwargs)

    def _download(self, path: str, params: Optional[Mapping[str, Any]] = None, dest: Optional[IO[bytes]] = None) -> Optional[bytes]:
        return self._client._download(path, params=params, dest=dest)


# -- account and deployment -------------------------------------------------


class MetaResource(_Base):
    def openapi(self) -> Json:
        """getOpenApiDocument: the OpenAPI document this deployment serves."""
        return self._get("/api/v1/openapi.json")

    def me(self) -> Json:
        """getMe: who the token belongs to, its role, mailboxes and capabilities."""
        return self._get("/api/v1/me")

    def config(self) -> Json:
        """getConfig: domains, addresses and zones this deployment serves."""
        return self._get("/api/v1/config")


class BrandingResource(_Base):
    def get(self) -> Json:
        """getBranding."""
        return self._get("/api/v1/branding")

    def update(self, **fields: Any) -> Json:
        """updateBranding: `appName`, `tagline`, `accentColor`."""
        return self._send("PUT", "/api/v1/branding", _clean(fields))

    def reset(self) -> Json:
        """resetBranding."""
        return self._send("DELETE", "/api/v1/branding")

    def logo(self, *, v: Optional[str] = None, dest: Optional[IO[bytes]] = None) -> Optional[bytes]:
        """getBrandingLogo: the image bytes (or streamed into `dest`)."""
        return self._download("/api/v1/branding/logo", {"v": v}, dest)

    def upload_logo(self, *, content: str, filename: str, type: str) -> Json:
        """uploadBrandingLogo: `content` is base64 without a data-URL prefix."""
        return self._send("PUT", "/api/v1/branding/logo", {"content": content, "filename": filename, "type": type})

    def delete_logo(self) -> Json:
        """deleteBrandingLogo."""
        return self._send("DELETE", "/api/v1/branding/logo")


class PreferencesResource(_Base):
    def get(self) -> Json:
        """getPreferences."""
        return self._get("/api/v1/preferences")

    def update(self, **fields: Any) -> Json:
        """updatePreferences: `notifications`, `display`, `sending`."""
        return self._send("PUT", "/api/v1/preferences", _clean(fields))


class AiResource(_Base):
    """AI settings. Provider and routing changes need a person in the app, so only reads and model checks are here."""

    def settings(self) -> Json:
        """getAiSettings."""
        return self._get("/api/v1/ai/settings")

    def update_settings(self, **fields: Any) -> Json:
        """updateAiSettings."""
        return self._send("PUT", "/api/v1/ai/settings", _clean(fields))

    def providers(self) -> Json:
        """listAiProviders."""
        return self._get("/api/v1/ai/providers")

    def discover_models(self, provider_id: str) -> Json:
        """discoverAiProviderModels."""
        return self._send("POST", f"/api/v1/ai/providers/{_seg(provider_id)}/discover")

    def test_model(self, provider_id: str, model_id: str, *, checks: Optional[Sequence[str]] = None) -> Json:
        """testAiProviderModel."""
        body = _clean({"modelId": model_id, "checks": list(checks) if checks is not None else None})
        return self._send("POST", f"/api/v1/ai/providers/{_seg(provider_id)}/test", body)

    def routing(self) -> Json:
        """getAiRouting."""
        return self._get("/api/v1/ai/routing")

    def workers_ai_models(self, *, task: Optional[str] = None, search: Optional[str] = None, refresh: Optional[bool] = None) -> Json:
        """listWorkersAiModels."""
        return self._get("/api/v1/ai/providers/workers-ai/models", task=task, search=search, refresh=_flag(refresh))

    def test_workers_ai_model(self, model_id: str, *, checks: Optional[Sequence[str]] = None) -> Json:
        """testWorkersAiModel."""
        body = _clean({"modelId": model_id, "checks": list(checks) if checks is not None else None})
        return self._send("POST", "/api/v1/ai/providers/workers-ai/test", body)

    def semantic_availability(self) -> Json:
        """getSemanticAvailability."""
        return self._get("/api/v1/ai/semantic")

    def semantic_status(self, mailbox: str) -> Json:
        """getSemanticStatus: one mailbox's semantic index."""
        return self._get(f"{_mb(mailbox)}/semantic")


class CloudflareResource(_Base):
    """Discovery and planning. Connecting, applying and reverting need a browser session."""

    def connection(self) -> Json:
        """getCloudflareConnection."""
        return self._get("/api/v1/cloudflare/connection")

    def discover(self, *, refresh: Optional[bool] = None) -> Json:
        """discoverCloudflare."""
        return self._get("/api/v1/cloudflare/discover", refresh=_flag(refresh))

    def plan(self, zones: Sequence[Any]) -> Json:
        """planCloudflareSetup."""
        return self._send("POST", "/api/v1/cloudflare/plan", {"zones": list(zones)})

    def changes(self, *, limit: Optional[int] = None, zone_id: Optional[str] = None) -> Json:
        """listCloudflareChanges."""
        return self._get("/api/v1/cloudflare/changes", limit=limit, zoneId=zone_id)


class LicenceResource(_Base):
    """The cloudmail licence. Activating and deactivating need a browser session."""

    def get(self) -> Json:
        """getLicence: status and lock state (plan and customer details for admins)."""
        return self._get("/api/v1/licence")

    def refresh(self) -> Json:
        """refreshLicence (admin): fetch a fresh signed token from the licence server."""
        return self._send("POST", "/api/v1/licence/refresh")


class AssistantResource(_Base):
    def prefs(self) -> Json:
        """getAssistantPrefs."""
        return self._get("/api/v1/me/assistant")

    def update_prefs(self, **fields: Any) -> Json:
        """updateAssistantPrefs: `listSummaries`, `brief`."""
        return self._send("PUT", "/api/v1/me/assistant", _clean(fields))

    def brief(self) -> Json:
        """getDailyBrief."""
        return self._get("/api/v1/me/brief")

    def generate_brief(self) -> Json:
        """generateDailyBrief."""
        return self._send("POST", "/api/v1/me/brief/generate")

    def dismiss_brief(self, brief_id: str) -> Json:
        """dismissDailyBrief."""
        return self._send("POST", f"/api/v1/me/brief/{_seg(brief_id)}/dismiss")


class NotificationsResource(_Base):
    """Web Push devices belong to a browser, so only the public key is here."""

    def vapid_key(self) -> Json:
        """getPushVapidKey."""
        return self._get("/api/v1/push/vapid-key")


class AccessResource(_Base):
    def list(self) -> Json:
        """listAccessGrants (admin)."""
        return self._get("/api/v1/access")

    def put(self, *, id: str, kind: str, role: str, **fields: Any) -> Json:
        """putAccessGrant (admin): grant a person or service a role."""
        return self._send("PUT", "/api/v1/access", _clean({"id": id, "kind": kind, "role": role, **fields}))

    def delete(self, kind: str, id: str) -> None:
        """deleteAccessGrant (admin)."""
        self._send("DELETE", f"/api/v1/access/{_seg(kind)}/{_seg(id)}")


class AuditResource(_Base):
    def list(self, mailbox: str, *, limit: Optional[int] = None, category: Optional[str] = None, action: Optional[str] = None, actor: Optional[str] = None) -> Json:
        """listMailboxAudit."""
        return self._get(f"{_mb(mailbox)}/audit", limit=limit, category=category, action=action, actor=actor)

    def instance(self, *, limit: Optional[int] = None, category: Optional[str] = None, action: Optional[str] = None, actor: Optional[str] = None) -> Json:
        """listInstanceAudit (admin)."""
        return self._get("/api/v1/access/audit", limit=limit, category=category, action=action, actor=actor)


class PrivacyResource(_Base):
    def tracking(self, mailbox: str) -> Json:
        """getTrackingSettings."""
        return self._get(f"{_mb(mailbox)}/settings/tracking")

    def update_tracking(self, mailbox: str, **fields: Any) -> Json:
        """updateTrackingSettings."""
        return self._send("PATCH", f"{_mb(mailbox)}/settings/tracking", _clean(fields))

    def settings(self) -> Json:
        """getPrivacySettings."""
        return self._get("/api/v1/privacy")

    def update_settings(self, **fields: Any) -> Json:
        """updatePrivacySettings (admin)."""
        return self._send("PUT", "/api/v1/privacy", _clean(fields))

    def account_deletion(self) -> Json:
        """getAccountDeletion."""
        return self._get("/api/v1/account/deletion")

    def cancel_account_deletion(self) -> Json:
        """cancelAccountDeletion."""
        return self._send("POST", "/api/v1/account/deletion/cancel")

    def exports(self) -> Json:
        """listAccountExports."""
        return self._get("/api/v1/account/exports")

    def download_export(self, export_id: str, token: str, *, dest: Optional[IO[bytes]] = None) -> Optional[bytes]:
        """downloadAccountExport: the ZIP. `token` is the signed value from the export's `downloadUrl`."""
        return self._download(f"/api/v1/account/exports/{_seg(export_id)}/download", {"token": token}, dest)


class MigrationResource(_Base):
    """Operator-only moves between Durable Object namespaces; needs `MIGRATION_TOKEN`."""

    def status(self, mailbox: str, *, migration_token: str) -> Json:
        """getMigrationStatus."""
        return self._client._json(
            "GET", f"/api/v1/_migrate/mailboxes/{_seg(mailbox)}/status", headers={"X-Migration-Token": migration_token}
        )

    def run(self, mailbox: str, *, migration_token: str, dry_run: Optional[bool] = None) -> Json:
        """migrateMailbox."""
        return self._client._json(
            "POST",
            f"/api/v1/_migrate/mailboxes/{_seg(mailbox)}",
            params={"dryRun": _flag(dry_run)},
            headers={"X-Migration-Token": migration_token},
        )


# -- inside a mailbox ---------------------------------------------------------


class DelegatesResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listMailboxDelegates."""
        return self._get(f"{_mb(mailbox)}/delegates")

    def put(self, mailbox: str, *, id: str, role: str, **fields: Any) -> Json:
        """putMailboxDelegate."""
        return self._send("PUT", f"{_mb(mailbox)}/delegates", _clean({"id": id, "role": role, **fields}))

    def delete(self, mailbox: str, kind: str, id: str) -> None:
        """deleteMailboxDelegate."""
        self._send("DELETE", f"{_mb(mailbox)}/delegates/{_seg(kind)}/{_seg(id)}")


class ThreadsResource(_Base):
    def _t(self, mailbox: str, thread_id: str) -> str:
        return f"{_mb(mailbox)}/threads/{_seg(thread_id)}"

    def get(self, mailbox: str, thread_id: str, *, folder: Optional[str] = None) -> Json:
        """getThread: every message in the thread."""
        return self._get(self._t(mailbox, thread_id), folder=folder)

    def summary(self, mailbox: str, thread_id: str) -> Json:
        """getThreadSummary."""
        return self._get(f"{self._t(mailbox, thread_id)}/summary")

    def refresh_summary(self, mailbox: str, thread_id: str) -> Json:
        """refreshThreadSummary: queue a fresh summary."""
        return self._send("POST", f"{self._t(mailbox, thread_id)}/summary/refresh")

    def generate_summary(self, mailbox: str, thread_id: str) -> Json:
        """generateThreadSummary: generate now and return it."""
        return self._send("POST", f"{self._t(mailbox, thread_id)}/summary/generate")

    def mark_read(self, mailbox: str, thread_id: str) -> Json:
        """markThreadRead."""
        return self._send("POST", f"{self._t(mailbox, thread_id)}/read")

    def mute(self, mailbox: str, thread_id: str) -> Json:
        """muteThread."""
        return self._send("POST", f"{self._t(mailbox, thread_id)}/mute")

    def unmute(self, mailbox: str, thread_id: str) -> Json:
        """unmuteThread."""
        return self._send("DELETE", f"{self._t(mailbox, thread_id)}/mute")

    def muted(self, mailbox: str) -> Json:
        """listMutedThreads."""
        return self._get(f"{_mb(mailbox)}/muted-threads")


class FoldersResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listFolders."""
        return self._get(f"{_mb(mailbox)}/folders")

    def create(self, mailbox: str, name: str) -> Json:
        """createFolder."""
        return self._send("POST", f"{_mb(mailbox)}/folders", {"name": name})

    def rename(self, mailbox: str, folder_id: str, name: str) -> Json:
        """renameFolder."""
        return self._send("PUT", f"{_mb(mailbox)}/folders/{_seg(folder_id)}", {"name": name})

    def delete(self, mailbox: str, folder_id: str) -> Json:
        """deleteFolder: its mail is moved out (see `movedTo`)."""
        return self._send("DELETE", f"{_mb(mailbox)}/folders/{_seg(folder_id)}")


class LabelsResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listLabels."""
        return self._get(f"{_mb(mailbox)}/labels")

    def create(self, mailbox: str, name: str, **fields: Any) -> Json:
        """createLabel: optional `color`, `parent_id`, `sort_order`."""
        return self._send("POST", f"{_mb(mailbox)}/labels", _clean({"name": name, **fields}))

    def update(self, mailbox: str, label_id: str, **fields: Any) -> Json:
        """updateLabel."""
        return self._send("PUT", f"{_mb(mailbox)}/labels/{_seg(label_id)}", _clean(fields))

    def delete(self, mailbox: str, label_id: str) -> None:
        """deleteLabel."""
        self._send("DELETE", f"{_mb(mailbox)}/labels/{_seg(label_id)}")

    def emails(self, mailbox: str, label_id: str, *, page: Optional[int] = None, limit: Optional[int] = None, unread: Optional[bool] = None, starred: Optional[bool] = None, has_attachment: Optional[bool] = None, sort_column: Optional[str] = None, sort_direction: Optional[str] = None) -> Json:
        """listLabelEmails: one page of mail with this label."""
        return self._get(
            f"{_mb(mailbox)}/labels/{_seg(label_id)}/emails",
            page=page, limit=limit, unread=_flag(unread), starred=_flag(starred),
            has_attachment=_flag(has_attachment), sortColumn=sort_column, sortDirection=sort_direction,
        )

    def for_email(self, mailbox: str, email_id: str) -> Json:
        """listEmailLabels."""
        return self._get(f"{_mb(mailbox)}/emails/{_seg(email_id)}/labels")

    def set_for_email(self, mailbox: str, email_id: str, label_ids: Sequence[str]) -> Json:
        """setEmailLabels: replace a message's labels."""
        return self._send("PUT", f"{_mb(mailbox)}/emails/{_seg(email_id)}/labels", {"label_ids": list(label_ids)})

    def add_to_email(self, mailbox: str, email_id: str, label_id: str) -> Json:
        """addEmailLabel."""
        return self._send("POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/labels", {"label_id": label_id})

    def remove_from_email(self, mailbox: str, email_id: str, label_id: str) -> None:
        """removeEmailLabel."""
        self._send("DELETE", f"{_mb(mailbox)}/emails/{_seg(email_id)}/labels/{_seg(label_id)}")


class SignaturesResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listSignatures."""
        return self._get(f"{_mb(mailbox)}/signatures")

    def create(self, mailbox: str, *, name: str, body_html: str, is_default: Optional[bool] = None) -> Json:
        """createSignature."""
        return self._send("POST", f"{_mb(mailbox)}/signatures", _clean({"name": name, "body_html": body_html, "is_default": is_default}))

    def get_default(self, mailbox: str) -> Json:
        """getDefaultSignature."""
        return self._get(f"{_mb(mailbox)}/signatures/default")

    def update(self, mailbox: str, signature_id: str, **fields: Any) -> Json:
        """updateSignature."""
        return self._send("PUT", f"{_mb(mailbox)}/signatures/{_seg(signature_id)}", _clean(fields))

    def delete(self, mailbox: str, signature_id: str) -> None:
        """deleteSignature."""
        self._send("DELETE", f"{_mb(mailbox)}/signatures/{_seg(signature_id)}")


class SnoozeResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listSnoozed."""
        return self._get(f"{_mb(mailbox)}/snoozed")

    def snooze(self, mailbox: str, email_id: str, *, until: Optional[str] = None, delay_seconds: Optional[int] = None) -> Json:
        """snoozeEmail: until an ISO time, or for `delay_seconds`."""
        return self._send("POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/snooze", _clean({"until": until, "delay_seconds": delay_seconds}))

    def unsnooze(self, mailbox: str, email_id: str) -> Json:
        """unsnoozeEmail."""
        return self._send("DELETE", f"{_mb(mailbox)}/emails/{_seg(email_id)}/snooze")


class FollowupsResource(_Base):
    def list(self, mailbox: str, *, status: Optional[str] = None, limit: Optional[int] = None) -> Json:
        """listFollowups."""
        return self._get(f"{_mb(mailbox)}/followups", status=status, limit=limit)

    def get(self, mailbox: str, email_id: str) -> Json:
        """getFollowup."""
        return self._get(f"{_mb(mailbox)}/emails/{_seg(email_id)}/followup")

    def set(self, mailbox: str, email_id: str, *, at: Optional[str] = None, delay_seconds: Optional[int] = None, idempotency_key: Optional[str] = None) -> Json:
        """setFollowup: remind if nobody replies by `at` (or after `delay_seconds`)."""
        return self._send(
            "POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/followup", _clean({"at": at, "delay_seconds": delay_seconds}),
            idempotent=True, idempotency_key=idempotency_key,
        )

    def delete(self, mailbox: str, email_id: str) -> Json:
        """deleteFollowup."""
        return self._send("DELETE", f"{_mb(mailbox)}/emails/{_seg(email_id)}/followup")

    def cancel(self, mailbox: str, email_id: str, *, idempotency_key: Optional[str] = None) -> Json:
        """cancelFollowup."""
        return self._send(
            "POST", f"{_mb(mailbox)}/emails/{_seg(email_id)}/followup/cancel", idempotent=True, idempotency_key=idempotency_key
        )


class TriageResource(_Base):
    def label_prompts(self, mailbox: str) -> Json:
        """listLabelPrompts."""
        return self._get(f"{_mb(mailbox)}/label-prompts")

    def set_label_prompt(self, mailbox: str, label_id: str, **fields: Any) -> Json:
        """setLabelPrompt: `prompt`, `auto_archive`, `show_tab`."""
        return self._send("PUT", f"{_mb(mailbox)}/labels/{_seg(label_id)}/prompt", _clean(fields))

    def set_preset(self, mailbox: str, key: str, *, enabled: bool, **fields: Any) -> Json:
        """setTriagePreset."""
        return self._send("PUT", f"{_mb(mailbox)}/triage/presets/{_seg(key)}", _clean({"enabled": enabled, **fields}))

    def backfill(self, mailbox: str, *, limit: Optional[int] = None) -> Json:
        """backfillTriage: classify recent unlabelled mail."""
        return self._send("POST", f"{_mb(mailbox)}/triage/backfill", _clean({"limit": limit}))

    def inbox_tabs(self, mailbox: str) -> Json:
        """listInboxTabs."""
        return self._get(f"{_mb(mailbox)}/inbox-tabs")


class ScreenerResource(_Base):
    def list(self, mailbox: str, *, limit: Optional[int] = None) -> Json:
        """listScreener."""
        return self._get(f"{_mb(mailbox)}/screener", limit=limit)

    def screen(self, mailbox: str, sender: str, decision: str, *, target: Optional[str] = None, idempotency_key: Optional[str] = None) -> Json:
        """screenSender: let a first-time sender in, or screen them out."""
        return self._send(
            "POST", f"{_mb(mailbox)}/screener/{_seg(sender)}", _clean({"decision": decision, "target": target}),
            idempotent=True, idempotency_key=idempotency_key,
        )


class ScheduledSendsResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listScheduledSends."""
        return self._get(f"{_mb(mailbox)}/scheduled-sends")

    def schedule(self, mailbox: str, *, to: Any, subject: str, idempotency_key: Optional[str] = None, **fields: Any) -> Json:
        """scheduleSend: the send body plus exactly one of `send_at` or `delay_seconds`.

        May return a `pending_approval` dict. A 5xx is not retried: it may have been queued.
        """
        body = _clean({"to": to if isinstance(to, str) else list(to), "subject": subject, **fields})
        body.setdefault("from", mailbox)
        return self._send("POST", f"{_mb(mailbox)}/scheduled-sends", body, idempotent=True, idempotency_key=idempotency_key)

    def cancel(self, mailbox: str, email_id: str) -> Json:
        """cancelScheduledSend."""
        return self._send("DELETE", f"{_mb(mailbox)}/scheduled-sends/{_seg(email_id)}")

    def send_now(self, mailbox: str, email_id: str, *, idempotency_key: Optional[str] = None) -> Json:
        """sendScheduledNow. Not retried on 5xx."""
        return self._send(
            "POST", f"{_mb(mailbox)}/scheduled-sends/{_seg(email_id)}/send-now", idempotent=True, idempotency_key=idempotency_key
        )


class SendersResource(_Base):
    def blocked(self, mailbox: str) -> Json:
        """listBlockedSenders."""
        return self._get(f"{_mb(mailbox)}/blocked-senders")

    def block(self, mailbox: str, pattern: str, *, reason: Optional[str] = None) -> Json:
        """blockSender."""
        return self._send("POST", f"{_mb(mailbox)}/blocked-senders", _clean({"pattern": pattern, "reason": reason}))

    def unblock(self, mailbox: str, block_id: str) -> None:
        """unblockSender."""
        self._send("DELETE", f"{_mb(mailbox)}/blocked-senders/{_seg(block_id)}")

    def allowed(self, mailbox: str) -> Json:
        """listAllowedSenders."""
        return self._get(f"{_mb(mailbox)}/allowed-senders")

    def allow(self, mailbox: str, pattern: str, *, reason: Optional[str] = None) -> Json:
        """allowSender."""
        return self._send("POST", f"{_mb(mailbox)}/allowed-senders", _clean({"pattern": pattern, "reason": reason}))

    def remove_allowed(self, mailbox: str, allow_id: str) -> None:
        """removeAllowedSender."""
        self._send("DELETE", f"{_mb(mailbox)}/allowed-senders/{_seg(allow_id)}")


class RulesResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listRules."""
        return self._get(f"{_mb(mailbox)}/rules")

    def create(self, mailbox: str, *, name: str, conditions: Sequence[Any], actions: Sequence[Any], **fields: Any) -> Json:
        """createRule."""
        body = _clean({"name": name, "conditions": list(conditions), "actions": list(actions), **fields})
        return self._send("POST", f"{_mb(mailbox)}/rules", body)

    def update(self, mailbox: str, rule_id: str, **fields: Any) -> Json:
        """updateRule."""
        return self._send("PUT", f"{_mb(mailbox)}/rules/{_seg(rule_id)}", _clean(fields))

    def delete(self, mailbox: str, rule_id: str) -> None:
        """deleteRule."""
        self._send("DELETE", f"{_mb(mailbox)}/rules/{_seg(rule_id)}")

    def reorder(self, mailbox: str, ids: Sequence[str]) -> Json:
        """reorderRules: every rule id, first to last."""
        return self._send("POST", f"{_mb(mailbox)}/rules/reorder", {"ids": list(ids)})


class ImportsResource(_Base):
    def list(self, mailbox: str) -> Json:
        """listImports."""
        return self._get(f"{_mb(mailbox)}/imports")

    def create(self, mailbox: str, *, idempotency_key: Optional[str] = None, **fields: Any) -> Json:
        """createImport: an upload (`source`, `size_bytes`, ...) or an IMAP import."""
        return self._send("POST", f"{_mb(mailbox)}/imports", _clean(fields), idempotent=True, idempotency_key=idempotency_key)

    def get(self, mailbox: str, import_id: str) -> Json:
        """getImport."""
        return self._get(f"{_mb(mailbox)}/imports/{_seg(import_id)}")

    def upload_part(self, mailbox: str, import_id: str, part: int, content: Union[bytes, bytearray, memoryview, str]) -> Json:
        """uploadImportPart: raw bytes for part `part` (from 1). Every part but the last is `upload.part_size` bytes."""
        data = content.encode() if isinstance(content, str) else bytes(content)
        return self._client._json("PUT", f"{_mb(mailbox)}/imports/{_seg(import_id)}/parts/{_seg(part)}", content=data)

    def complete(self, mailbox: str, import_id: str) -> Json:
        """completeImport."""
        return self._send("POST", f"{_mb(mailbox)}/imports/{_seg(import_id)}/complete")

    def pause(self, mailbox: str, import_id: str) -> Json:
        """pauseImport."""
        return self._send("POST", f"{_mb(mailbox)}/imports/{_seg(import_id)}/pause")

    def resume(self, mailbox: str, import_id: str) -> Json:
        """resumeImport."""
        return self._send("POST", f"{_mb(mailbox)}/imports/{_seg(import_id)}/resume")

    def cancel(self, mailbox: str, import_id: str) -> Json:
        """cancelImport."""
        return self._send("POST", f"{_mb(mailbox)}/imports/{_seg(import_id)}/cancel")


# -- instance-wide ------------------------------------------------------------


class ProductsResource(_Base):
    def list(self) -> Json:
        """listProducts."""
        return self._get("/api/v1/products")

    def create(self, **fields: Any) -> Json:
        """createProduct."""
        return self._send("POST", "/api/v1/products", _clean(fields))

    def resolve(self, from_: str) -> Json:
        """resolveProduct: the product a sending address belongs to."""
        return self._get("/api/v1/products/resolve", **{"from": from_})

    def get(self, product_id: str) -> Json:
        """getProduct."""
        return self._get(f"/api/v1/products/{_seg(product_id)}")

    def update(self, product_id: str, **fields: Any) -> Json:
        """updateProduct."""
        return self._send("PATCH", f"/api/v1/products/{_seg(product_id)}", _clean(fields))

    def delete(self, product_id: str) -> Json:
        """deleteProduct."""
        return self._send("DELETE", f"/api/v1/products/{_seg(product_id)}")

    def put_logo(self, product_id: str, *, content: str, filename: str, type: str) -> Json:
        """putProductLogo: `content` is base64."""
        return self._send("PUT", f"/api/v1/products/{_seg(product_id)}/logo", {"content": content, "filename": filename, "type": type})

    def delete_logo(self, product_id: str) -> Json:
        """deleteProductLogo."""
        return self._send("DELETE", f"/api/v1/products/{_seg(product_id)}/logo")

    def refresh_knowledge(self, product_id: str) -> Json:
        """refreshProductKnowledge."""
        return self._send("POST", f"/api/v1/products/{_seg(product_id)}/knowledge/refresh")


class PeopleResource(_Base):
    def list(self, **params: Any) -> Json:
        """listPeople: `folder`, `page`, `pageSize`, `search`, `unread`, `hasAttachment`, `recipient`, `sortKey`, `sortDirection`."""
        return self._get("/api/v1/people", **{k: _flag(v) if isinstance(v, bool) else v for k, v in params.items()})

    def emails(self, person: str, *, limit: Optional[int] = None) -> Json:
        """listPersonEmails."""
        return self._get(f"/api/v1/people/{_seg(person)}/emails", limit=limit)


class AnalyticsResource(_Base):
    def get(self, *, days: Optional[int] = None) -> Json:
        """getAnalytics."""
        return self._get("/api/v1/analytics", days=days)

    def sent(self, *, days: Optional[int] = None) -> Json:
        """getSentAnalytics."""
        return self._get("/api/v1/analytics/sent", days=days)

    def overview(self, **params: Any) -> Json:
        """getAnalyticsOverview: `days`, `scope`, `domain`, `product`, `refresh`."""
        return self._get("/api/v1/analytics/overview", **params)

    def engagement(self, **params: Any) -> Json:
        """getAnalyticsEngagement: `days`, `mailbox`, `refresh`."""
        return self._get("/api/v1/analytics/engagement", **params)

    def inbound(self, **params: Any) -> Json:
        """getAnalyticsInbound: `days`, `refresh`."""
        return self._get("/api/v1/analytics/inbound", **params)

    def dmarc(self, **params: Any) -> Json:
        """getAnalyticsDmarc: `days`, `refresh`."""
        return self._get("/api/v1/analytics/dmarc", **params)


class TemplatesResource(_Base):
    def list(self) -> Json:
        """listTemplates."""
        return self._get("/api/v1/templates")

    def create(self, *, slug: str, name: str, subject: str, body_html: str) -> Json:
        """createTemplate."""
        return self._send("POST", "/api/v1/templates", {"slug": slug, "name": name, "subject": subject, "bodyHtml": body_html})

    def get(self, slug: str) -> Json:
        """getTemplate."""
        return self._get(f"/api/v1/templates/{_seg(slug)}")

    def update(self, slug: str, *, name: Optional[str] = None, subject: Optional[str] = None, body_html: Optional[str] = None) -> Json:
        """updateTemplate."""
        return self._send("PUT", f"/api/v1/templates/{_seg(slug)}", _clean({"name": name, "subject": subject, "bodyHtml": body_html}))

    def delete(self, slug: str) -> Json:
        """deleteTemplate."""
        return self._send("DELETE", f"/api/v1/templates/{_seg(slug)}")

    def send(self, mailbox: str, template: str, recipients: Sequence[Any], *, idempotency_key: Optional[str] = None, **fields: Any) -> Json:
        """sendTemplate: may return `pending_approval`. Not retried on 5xx."""
        body = _clean({"template": template, "recipients": list(recipients), **fields})
        return self._send("POST", f"{_mb(mailbox)}/template-sends", body, idempotent=True, idempotency_key=idempotency_key)


class SequencesResource(_Base):
    def list(self) -> Json:
        """listSequences."""
        return self._get("/api/v1/sequences")

    def create(self, name: str, steps: Sequence[Any]) -> Json:
        """createSequence."""
        return self._send("POST", "/api/v1/sequences", {"name": name, "steps": list(steps)})

    def get(self, sequence_id: str) -> Json:
        """getSequence."""
        return self._get(f"/api/v1/sequences/{_seg(sequence_id)}")

    def update(self, sequence_id: str, **fields: Any) -> Json:
        """updateSequence: `name`, `steps`."""
        return self._send("PUT", f"/api/v1/sequences/{_seg(sequence_id)}", _clean(fields))

    def delete(self, sequence_id: str) -> Json:
        """deleteSequence."""
        return self._send("DELETE", f"/api/v1/sequences/{_seg(sequence_id)}")

    def enrollments(self, sequence_id: str) -> Json:
        """listSequenceEnrollments."""
        return self._get(f"/api/v1/sequences/{_seg(sequence_id)}/enrollments")

    def enroll(self, sequence_id: str, *, person_id: str, person_email: str, from_address: str, idempotency_key: Optional[str] = None, **fields: Any) -> Json:
        """enrollInSequence: may return `pending_approval`. Not retried on 5xx."""
        body = _clean({"personId": person_id, "personEmail": person_email, "fromAddress": from_address, **fields})
        return self._send("POST", f"/api/v1/sequences/{_seg(sequence_id)}/enroll", body, idempotent=True, idempotency_key=idempotency_key)

    def person_enrollment(self, person_id: str) -> Json:
        """getPersonEnrollment."""
        return self._get(f"/api/v1/sequences/people/{_seg(person_id)}/enrollment")

    def cancel_enrollment(self, enrollment_id: str) -> Json:
        """cancelEnrollment."""
        return self._send("DELETE", f"/api/v1/sequences/enrollments/{_seg(enrollment_id)}")


class SuppressionsResource(_Base):
    def list(self, **params: Any) -> Json:
        """listSuppressions: `q`, `scope`, `reason`, `limit`, `offset`."""
        return self._get("/api/v1/suppressions", **params)

    def add(self, entries: Union[Mapping[str, Any], Sequence[Mapping[str, Any]]], *, idempotency_key: Optional[str] = None) -> Json:
        """addSuppressions: one entry, or a list of up to 1000."""
        body: Any = dict(entries) if isinstance(entries, Mapping) else {"entries": [dict(e) for e in entries]}
        return self._send("POST", "/api/v1/suppressions", body, idempotent=True, idempotency_key=idempotency_key)

    def import_csv(self, csv: str, *, scope: Optional[str] = None, reason: Optional[str] = None) -> Json:
        """importSuppressions."""
        return self._send("POST", "/api/v1/suppressions/import", _clean({"csv": csv, "scope": scope, "reason": reason}))

    def check(self, addresses: Sequence[str], *, from_: Optional[str] = None) -> Json:
        """checkSuppressions: which of these would be dropped from a send."""
        return self._send("POST", "/api/v1/suppressions/check", _clean({"addresses": list(addresses), "from": from_}))

    def delete(self, suppression_id: str) -> Json:
        """deleteSuppression."""
        return self._send("DELETE", f"/api/v1/suppressions/{_seg(suppression_id)}")


class SendingHealthResource(_Base):
    def list(self) -> Json:
        """listSendingHealth."""
        return self._get("/api/v1/sending-health")

    def evaluate(self) -> Json:
        """evaluateSendingHealth."""
        return self._send("POST", "/api/v1/sending-health/evaluate")

    def resume(self, domain: str) -> Json:
        """resumeBulkSending (admin): lift the spam-rate breaker."""
        return self._send("POST", f"/api/v1/sending-health/{_seg(domain)}/resume")

    def pause(self, domain: str, *, reason: Optional[str] = None) -> Json:
        """pauseBulkSending (admin)."""
        return self._send("POST", f"/api/v1/sending-health/{_seg(domain)}/pause", _clean({"reason": reason}))

    def limits(self, mailbox: str) -> Json:
        """getSendLimits."""
        return self._get(f"{_mb(mailbox)}/send-limits")

    def update_limits(self, mailbox: str, *, hourly: Optional[int] = None, daily: Optional[int] = None) -> Json:
        """updateSendLimits."""
        return self._send("PUT", f"{_mb(mailbox)}/send-limits", _clean({"hourly": hourly, "daily": daily}))


class UsageResource(_Base):
    def get(self, *, refresh: Optional[bool] = None) -> Json:
        """getUsage (admin)."""
        return self._get("/api/v1/usage", refresh=_flag(refresh))

    def update_budget(self, **fields: Any) -> Json:
        """updateUsageBudget: `ai_usd`, `email_usd`."""
        return self._send("PUT", "/api/v1/usage/budget", fields)


class DomainsResource(_Base):
    def list(self) -> Json:
        """listDomains."""
        return self._get("/api/v1/domains")

    def create(self, hostname: str, *, idempotency_key: Optional[str] = None, **fields: Any) -> Json:
        """createDomain."""
        return self._send("POST", "/api/v1/domains", _clean({"hostname": hostname, **fields}), idempotent=True, idempotency_key=idempotency_key)

    def get(self, domain_id: str) -> Json:
        """getDomain."""
        return self._get(f"/api/v1/domains/{_seg(domain_id)}")

    def update(self, domain_id: str, **fields: Any) -> Json:
        """updateDomain."""
        return self._send("PATCH", f"/api/v1/domains/{_seg(domain_id)}", fields)

    def delete(self, domain_id: str) -> Json:
        """deleteDomain."""
        return self._send("DELETE", f"/api/v1/domains/{_seg(domain_id)}")

    def verify(self, domain_id: str) -> Json:
        """verifyDomain."""
        return self._send("POST", f"/api/v1/domains/{_seg(domain_id)}/verify")

    def provision(self, domain_id: str, **fields: Any) -> Json:
        """provisionDomain: DNS records and email routing on Cloudflare."""
        return self._send("POST", f"/api/v1/domains/{_seg(domain_id)}/provision", _clean(fields))


__all__: List[str] = [name for name in dir() if name.endswith("Resource")]
