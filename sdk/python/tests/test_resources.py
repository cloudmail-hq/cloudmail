import io
import json
import warnings

import httpx
import pytest
import respx

from cloudmail import (
    ApprovalChangedError,
    Cloudmail,
    ConflictError,
    RateLimitError,
    ServerError,
    Tapetide,
    ValidationError,
    is_pending_approval,
)

BASE = "https://mail.example.com"
MB = "agent@example.com"
MB_PATH = "/api/v1/mailboxes/agent%40example.com"


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def cm(sleeps):
    client = Cloudmail(BASE, "ttk_abc_def", sleep=sleeps.append)
    yield client
    client.close()


def body_of(request):
    return json.loads(request.content) if request.content else None


def test_cloudmail_is_tapetide():
    assert Cloudmail is Tapetide


def test_tapetide_shim_warns_and_reexports():
    import importlib
    import sys

    sys.modules.pop("tapetide", None)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        shim = importlib.import_module("tapetide")
    assert any(issubclass(w.category, DeprecationWarning) for w in caught)
    assert shim.Tapetide is Tapetide
    from tapetide.webhooks import verify_webhook  # submodules still import

    assert verify_webhook.__module__ == "cloudmail.webhooks"


@respx.mock
def test_revise_posts_the_patch_body(cm):
    route = respx.post(f"{BASE}{MB_PATH}/approvals/a1/revise").mock(
        return_value=httpx.Response(200, json={"approval": {"id": "a1", "status": "pending", "revision": 2, "revised_by": "requester"}})
    )
    a = cm.approvals.revise(MB, "a1", html="<p>v2</p>", to=["x@y.com"])
    assert a.revision == 2 and a.revised_by == "requester"
    req = route.calls.last.request
    assert body_of(req) == {"html": "<p>v2</p>", "to": ["x@y.com"]}
    assert "idempotency-key" not in req.headers


@respx.mock
def test_approve_sends_revision_and_raises_approval_changed(cm):
    route = respx.post(f"{BASE}{MB_PATH}/approvals/a1/approve").mock(
        return_value=httpx.Response(409, json={"error": "It was changed", "approval": {"id": "a1", "status": "pending", "revision": 4}})
    )
    with pytest.raises(ApprovalChangedError) as err:
        cm.approvals.approve(MB, "a1", revision=3)
    assert isinstance(err.value, ConflictError)
    assert err.value.approval.revision == 4
    assert body_of(route.calls.last.request) == {"revision": 3}
    assert route.call_count == 1


@respx.mock
def test_approve_already_decided_is_a_plain_conflict(cm):
    respx.post(f"{BASE}{MB_PATH}/approvals/a1/approve").mock(
        return_value=httpx.Response(409, json={"error": "Already sent", "approval": {"id": "a1", "status": "sent"}})
    )
    with pytest.raises(ConflictError) as err:
        cm.approvals.approve(MB, "a1")
    assert not isinstance(err.value, ApprovalChangedError)


@respx.mock
def test_approve_without_revision_sends_no_body_and_never_retries_5xx(cm):
    route = respx.post(f"{BASE}{MB_PATH}/approvals/a1/approve").mock(return_value=httpx.Response(502, json={"error": "sent_unconfirmed"}))
    with pytest.raises(ServerError):
        cm.approvals.approve(MB, "a1")
    assert route.call_count == 1
    assert route.calls.last.request.content == b""


@respx.mock
def test_agent_flow(cm, sleeps):
    respx.post(f"{BASE}{MB_PATH}/emails").mock(
        return_value=httpx.Response(202, json={"status": "pending_approval", "approval_id": "a1", "approval_url": "https://x"})
    )
    respx.post(f"{BASE}{MB_PATH}/approvals/a1/revise").mock(
        return_value=httpx.Response(200, json={"approval": {"id": "a1", "status": "pending", "revision": 2}})
    )
    respx.get(f"{BASE}{MB_PATH}/approvals/a1").mock(
        side_effect=[
            httpx.Response(200, json={"approval": {"id": "a1", "status": "pending", "revision": 2}}),
            httpx.Response(200, json={"approval": {"id": "a1", "status": "sent", "revision": 2}}),
        ]
    )
    sent = cm.mail.send(MB, to="c@d.com", subject="Hi", html="<p>v1</p>")
    assert is_pending_approval(sent)
    cm.approvals.revise(MB, sent.approval_id, html="<p>v2</p>")
    final = cm.approvals.wait_for_decision(MB, sent.approval_id, interval=3)
    assert final.status == "sent" and sleeps == [3]


@respx.mock
def test_rate_limit_exposes_retry_after(cm):
    respx.get(f"{BASE}{MB_PATH}/labels").mock(
        return_value=httpx.Response(429, json={"error": "Over the cap", "code": "send_cap"}, headers={"Retry-After": "120"})
    )
    cm.max_retries = 0
    with pytest.raises(RateLimitError) as err:
        cm.labels.list(MB)
    assert err.value.retry_after == 120.0 and err.value.code == "send_cap"


@respx.mock
def test_validation_error_for_400_and_422(cm):
    respx.post(f"{BASE}{MB_PATH}/labels").mock(return_value=httpx.Response(422, json={"error": "bad name"}))
    with pytest.raises(ValidationError):
        cm.labels.create(MB, "")


@respx.mock
def test_template_and_sequence_sends_are_keyed_and_not_retried(cm):
    t = respx.post(f"{BASE}{MB_PATH}/template-sends").mock(return_value=httpx.Response(503, json={"error": "x"}))
    s = respx.post(f"{BASE}/api/v1/sequences/seq1/enroll").mock(return_value=httpx.Response(500, json={"error": "x"}))
    with pytest.raises(ServerError):
        cm.templates.send(MB, "welcome", [{"email": "a@b.com"}])
    with pytest.raises(ServerError):
        cm.sequences.enroll("seq1", person_id="p", person_email="a@b.com", from_address=MB)
    assert t.call_count == 1 and s.call_count == 1
    assert "idempotency-key" in t.calls.last.request.headers


@respx.mock
def test_schedule_defaults_from(cm):
    route = respx.post(f"{BASE}{MB_PATH}/scheduled-sends").mock(return_value=httpx.Response(201, json={"id": "e1", "status": "scheduled"}))
    cm.scheduled_sends.schedule(MB, to="a@b.com", subject="s", text="t", delay_seconds=60)
    assert body_of(route.calls.last.request) == {"to": "a@b.com", "subject": "s", "text": "t", "delay_seconds": 60, "from": MB}


@respx.mock
def test_download_bytes_and_stream(cm):
    respx.get(f"{BASE}{MB_PATH}/export").mock(return_value=httpx.Response(200, content=b"From x\n", headers={"Content-Type": "application/mbox"}))
    assert cm.mailboxes.export(MB) == b"From x\n"
    buf = io.BytesIO()
    assert cm.mailboxes.export(MB, dest=buf) is None
    assert buf.getvalue() == b"From x\n"


@respx.mock
def test_download_error_raises(cm):
    respx.get(f"{BASE}{MB_PATH}/emails/e1/attachments/x").mock(return_value=httpx.Response(404, json={"error": "Attachment not found"}))
    with pytest.raises(Exception) as err:
        cm.mail.attachment(MB, "e1", "x")
    assert getattr(err.value, "status", None) == 404


@respx.mock
def test_upload_part_sends_raw_bytes(cm):
    route = respx.put(f"{BASE}{MB_PATH}/imports/i1/parts/2").mock(return_value=httpx.Response(200, json={"id": "i1"}))
    cm.imports.upload_part(MB, "i1", 2, b"\x00\x01")
    req = route.calls.last.request
    assert req.content == b"\x00\x01" and req.headers["content-type"] == "application/octet-stream"


@respx.mock
def test_iter_unified_follows_the_cursor(cm):
    route = respx.get(f"{BASE}/api/v1/inbox").mock(
        side_effect=[
            httpx.Response(200, json={"emails": [{"id": "1"}], "nextCursor": "c2"}),
            httpx.Response(200, json={"emails": [{"id": "2"}], "nextCursor": None}),
        ]
    )
    assert [e["id"] for e in cm.mail.iter_unified(unread=True)] == ["1", "2"]
    assert dict(route.calls[1].request.url.params) == {"cursor": "c2", "unread": "true"}


@respx.mock
def test_migration_token_header(cm):
    route = respx.get(f"{BASE}/api/v1/_migrate/mailboxes/agent%40example.com/status").mock(return_value=httpx.Response(200, json={}))
    cm.migration.status(MB, migration_token="mig")
    assert route.calls.last.request.headers["x-migration-token"] == "mig"
