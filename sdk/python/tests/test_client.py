import json

import httpx
import pytest
import respx

from cloudmail import (
    APIConnectionError,
    AuthenticationError,
    ConflictError,
    NotFoundError,
    PendingApproval,
    PermissionDeniedError,
    RateLimitError,
    SendAccepted,
    ServerError,
    Tapetide,
    TapetideError,
    __version__,
    is_pending_approval,
)

BASE = "https://mail.example.com"
MB = "support@example.com"
MB_PATH = "/api/v1/mailboxes/support%40example.com"


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def tt(sleeps):
    client = Tapetide(BASE + "/", "ttk_abc_def", sleep=sleeps.append)
    yield client
    client.close()


def body_of(request):
    return json.loads(request.content)


@respx.mock
def test_send_request_shape(tt):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(
        return_value=httpx.Response(202, json={"id": "m1", "status": "sent"})
    )
    result = tt.mail.send(MB, to=["a@b.com", "c@d.com"], subject="Hi", text="Hello", cc="e@f.com", track=False)
    assert isinstance(result, SendAccepted) and result.id == "m1"
    assert not is_pending_approval(result)
    req = route.calls.last.request
    assert req.headers["authorization"] == "Bearer ttk_abc_def"
    assert req.headers["user-agent"] == f"cloudmail-python/{__version__}"
    assert req.headers["content-type"] == "application/json"
    assert len(req.headers["idempotency-key"]) == 36
    assert body_of(req) == {
        "to": ["a@b.com", "c@d.com"],
        "cc": "e@f.com",
        "from": MB,
        "subject": "Hi",
        "text": "Hello",
        "track": False,
    }


@respx.mock
def test_send_requires_a_body(tt):
    with pytest.raises(ValueError):
        tt.mail.send(MB, to="a@b.com", subject="x")


@respx.mock
def test_send_with_named_from_and_caller_key(tt):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(return_value=httpx.Response(202, json={"id": "m", "status": "sent"}))
    tt.mail.send(MB, to="a@b.com", subject="s", html="<p>x</p>", from_={"email": MB, "name": "Support"}, idempotency_key="order-42")
    req = route.calls.last.request
    assert req.headers["idempotency-key"] == "order-42"
    assert body_of(req)["from"] == {"email": MB, "name": "Support"}


@respx.mock
def test_pending_approval_is_returned_not_raised(tt):
    respx.post(f"{BASE}{MB_PATH}/emails/e%2F1/reply").mock(
        return_value=httpx.Response(
            202,
            json={
                "status": "pending_approval",
                "approval_id": "apr_1",
                "approval_url": "https://mail.example.com/approvals/apr_1",
                "reason": "approval_required",
            },
        )
    )
    result = tt.mail.reply(MB, "e/1", to="a@b.com", subject="Re: x", text="ok")
    assert isinstance(result, PendingApproval)
    assert is_pending_approval(result)
    assert result.approval_id == "apr_1"


@respx.mock
def test_retry_on_503_reuses_the_same_key_for_a_keyed_create(tt, sleeps):
    route = respx.post(f"{BASE}/api/v1/mailboxes").mock(
        side_effect=[
            httpx.Response(503, json={"error": "upstream"}),
            httpx.Response(502, text="bad gateway"),
            httpx.Response(201, json={"id": MB, "email": MB, "name": "S"}),
        ]
    )
    assert tt.mailboxes.create(MB, "S").email == MB
    keys = {c.request.headers["idempotency-key"] for c in route.calls}
    assert route.call_count == 3 and len(keys) == 1
    assert len(sleeps) == 2


@pytest.mark.parametrize("status", [500, 502, 503, 408])
@respx.mock
def test_send_is_not_retried_on_5xx_or_408(tt, status):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(return_value=httpx.Response(status, json={"error": "upstream"}))
    with pytest.raises(TapetideError) as err:
        tt.mail.send(MB, to="a@b.com", subject="s", text="t")
    assert err.value.status == status
    if status >= 500:
        assert isinstance(err.value, ServerError)
    assert route.call_count == 1


@respx.mock
def test_send_retries_a_503_refused_before_running(tt, sleeps):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(
        side_effect=[
            httpx.Response(503, json={"error": "x", "code": "idempotency_unavailable"}, headers={"Retry-After": "1"}),
            httpx.Response(202, json={"id": "m1", "status": "sent"}),
        ]
    )
    assert tt.mail.send(MB, to="a@b.com", subject="s", text="t").id == "m1"
    assert route.call_count == 2 and sleeps == [1.0]
    assert len({c.request.headers["idempotency-key"] for c in route.calls}) == 1


@respx.mock
def test_send_retries_429_with_the_same_key(tt):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(
        side_effect=[
            httpx.Response(429, json={"error": "slow"}, headers={"Retry-After": "2"}),
            httpx.Response(202, json={"id": "m1", "status": "sent"}),
        ]
    )
    tt.mail.send(MB, to="a@b.com", subject="s", text="t")
    assert route.call_count == 2
    assert len({c.request.headers["idempotency-key"] for c in route.calls}) == 1


@respx.mock
def test_retry_on_transport_error_reuses_the_same_key(tt):
    seen = []

    def handler(request):
        seen.append(request.headers["idempotency-key"])
        if len(seen) == 1:
            raise httpx.ConnectError("reset")
        return httpx.Response(202, json={"id": "m2", "status": "sent"})

    respx.post(f"{BASE}{MB_PATH}/emails/x/forward").mock(side_effect=handler)
    assert tt.mail.forward(MB, "x", to="a@b.com", subject="Fwd", text="t").id == "m2"
    assert len(seen) == 2 and seen[0] == seen[1]


@respx.mock
def test_retry_honours_in_progress_and_retry_after(tt, sleeps):
    route = respx.post(f"{BASE}/api/v1/webhooks").mock(
        side_effect=[
            httpx.Response(409, json={"code": "idempotency_request_in_progress", "error": "busy"}, headers={"Retry-After": "1"}),
            httpx.Response(201, json={"webhook": {"id": "wh_1", "name": "n", "url": "https://x.dev/h", "events": ["message.received"]}, "secret": "whsec_x"}),
        ]
    )
    created = tt.webhooks.create(name="n", url="https://x.dev/h", events=["message.received"])
    assert created.secret == "whsec_x" and created.webhook.id == "wh_1"
    assert sleeps == [1.0]
    assert route.calls[0].request.headers["idempotency-key"] == route.calls[1].request.headers["idempotency-key"]


@respx.mock
def test_gives_up_after_max_retries(tt):
    route = respx.get(f"{BASE}{MB_PATH}/emails/1").mock(return_value=httpx.Response(500, json={"error": "boom"}))
    with pytest.raises(ServerError) as err:
        tt.mail.get(MB, "1")
    assert err.value.status == 500 and err.value.message == "boom"
    assert route.call_count == 3


@respx.mock
def test_transport_error_after_retries_is_connection_error(tt):
    respx.get(f"{BASE}{MB_PATH}/emails/1").mock(side_effect=httpx.ConnectTimeout("slow"))
    with pytest.raises(APIConnectionError):
        tt.mail.get(MB, "1")


@respx.mock
def test_no_retry_on_400(tt):
    route = respx.post(f"{BASE}{MB_PATH}/emails").mock(return_value=httpx.Response(400, json={"error": "bad to"}))
    with pytest.raises(TapetideError) as err:
        tt.mail.send(MB, to="nope", subject="s", text="t")
    assert route.call_count == 1 and err.value.status == 400


@respx.mock
def test_unkeyed_writes_are_not_retried(tt):
    route = respx.put(f"{BASE}{MB_PATH}").mock(side_effect=httpx.ConnectError("reset"))
    with pytest.raises(APIConnectionError):
        tt.mailboxes.update(MB, {"fromName": "X"})
    assert route.call_count == 1
    assert "idempotency-key" not in route.calls.last.request.headers


@pytest.mark.parametrize(
    "status,cls",
    [(401, AuthenticationError), (403, PermissionDeniedError), (404, NotFoundError), (409, ConflictError), (429, RateLimitError)],
)
@respx.mock
def test_error_mapping(tt, status, cls):
    respx.get(f"{BASE}{MB_PATH}").mock(return_value=httpx.Response(status, json={"error": "e", "code": "c"}))
    with pytest.raises(cls) as err:
        tt.mailboxes.get(MB)
    assert err.value.status == status and err.value.code == "c" and err.value.message == "e"


@respx.mock
def test_list_and_search_query(tt):
    page = {"emails": [{"id": "1", "subject": "a", "sender": "x", "recipient": MB, "date": "2026-01-01", "read": False, "starred": False, "new_field": 1}], "totalCount": 1}
    lst = respx.get(f"{BASE}{MB_PATH}/emails").mock(return_value=httpx.Response(200, json=page))
    srch = respx.get(f"{BASE}{MB_PATH}/search").mock(return_value=httpx.Response(200, json=page))
    got = tt.mail.list(MB, limit=10, unread=True)
    assert got.totalCount == 1 and got.emails[0].id == "1"
    assert got.emails[0].new_field == 1  # extra fields survive
    assert dict(lst.calls.last.request.url.params) == {"folder": "inbox", "limit": "10", "unread": "true"}
    tt.mail.search(MB, "from:a@b.com has:attachment", limit=5)
    assert dict(srch.calls.last.request.url.params) == {"query": "from:a@b.com has:attachment", "limit": "5"}


@respx.mock
def test_list_without_folder_returns_bare_array(tt):
    respx.get(f"{BASE}{MB_PATH}/emails").mock(return_value=httpx.Response(200, json=[{"id": "1"}, {"id": "2"}]))
    got = tt.mail.list(MB, folder=None)
    assert [e.id for e in got.emails] == ["1", "2"] and got.totalCount == 2


@respx.mock
def test_mailboxes(tt):
    create = respx.post(f"{BASE}/api/v1/mailboxes").mock(
        return_value=httpx.Response(201, json={"id": MB, "email": MB, "name": "Support"})
    )
    respx.get(f"{BASE}/api/v1/mailboxes").mock(return_value=httpx.Response(200, json=[{"id": MB, "email": MB, "name": "S"}]))
    delete = respx.delete(f"{BASE}{MB_PATH}").mock(return_value=httpx.Response(204))
    assert tt.mailboxes.create(MB, "Support").email == MB
    assert "idempotency-key" in create.calls.last.request.headers
    assert body_of(create.calls.last.request) == {"email": MB, "name": "Support"}
    assert tt.mailboxes.list()[0].name == "S"
    assert tt.mailboxes.delete(MB) is None and delete.called


@respx.mock
def test_agent_inbox_create(tt):
    route = respx.post(f"{BASE}/api/v1/agent-inboxes").mock(
        return_value=httpx.Response(
            201,
            json={
                "agent_inbox": {"address": "agent-x@example.com", "send_mode": "approve"},
                "address": "agent-x@example.com",
                "token": {"id": "tok_1", "secret": "ttk_s", "scopes": ["mail:read"], "mailboxes": ["agent-x@example.com"]},
                "webhook": None,
                "warnings": [],
            },
        )
    )
    got = tt.agent_inboxes.create(domain="example.com", purpose="triage", send_mode="approve", ttl_hours=24)
    assert got.token.secret == "ttk_s" and got.address == "agent-x@example.com"
    req = route.calls.last.request
    assert body_of(req) == {"domain": "example.com", "purpose": "triage", "send_mode": "approve", "ttl_hours": 24}
    assert "idempotency-key" in req.headers


@respx.mock
def test_agent_inbox_get_and_delete_encode_address(tt):
    respx.get(f"{BASE}/api/v1/agent-inboxes/a%40x.com").mock(
        return_value=httpx.Response(200, json={"agent_inbox": {"address": "a@x.com"}})
    )
    respx.delete(f"{BASE}/api/v1/agent-inboxes/a%40x.com").mock(
        return_value=httpx.Response(200, json={"ended": {"address": "a@x.com", "token_revoked": True}})
    )
    assert tt.agent_inboxes.get("a@x.com").address == "a@x.com"
    assert tt.agent_inboxes.delete("a@x.com")["token_revoked"] is True


@respx.mock
def test_webhook_endpoints(tt):
    hook = {"id": "wh_1", "name": "n", "url": "https://x.dev", "events": ["message.sent"]}
    patch = respx.patch(f"{BASE}/api/v1/webhooks/wh_1").mock(return_value=httpx.Response(200, json={"webhook": hook}))
    respx.post(f"{BASE}/api/v1/webhooks/wh_1/rotate-secret").mock(return_value=httpx.Response(200, json={"webhook": hook, "secret": "whsec_new"}))
    respx.post(f"{BASE}/api/v1/webhooks/wh_1/test").mock(return_value=httpx.Response(200, json={"delivery": {"id": "whd_1", "status": "delivered"}}))
    deliveries = respx.get(f"{BASE}/api/v1/webhooks/wh_1/deliveries").mock(return_value=httpx.Response(200, json={"deliveries": [{"id": "whd_1", "status": "failed", "attempts": 2}]}))
    assert tt.webhooks.update("wh_1", enabled=False).id == "wh_1"
    assert body_of(patch.calls.last.request) == {"enabled": False}
    assert tt.webhooks.rotate_secret("wh_1").secret == "whsec_new"
    assert tt.webhooks.test("wh_1").status == "delivered"
    assert tt.webhooks.deliveries("wh_1", limit=5)[0].attempts == 2
    assert deliveries.calls.last.request.url.params["limit"] == "5"


@respx.mock
def test_approvals(tt):
    respx.get(f"{BASE}{MB_PATH}/approvals").mock(return_value=httpx.Response(200, json={"approvals": [{"id": "apr_1", "status": "pending"}]}))
    respx.get(f"{BASE}{MB_PATH}/approvals/count").mock(return_value=httpx.Response(200, json={"pending": 3}))
    approve = respx.post(f"{BASE}{MB_PATH}/approvals/apr_1/approve").mock(
        return_value=httpx.Response(200, json={"approval": {"id": "apr_1", "status": "sent"}, "result": {"id": "m1"}})
    )
    reject = respx.post(f"{BASE}{MB_PATH}/approvals/apr_2/reject").mock(
        return_value=httpx.Response(200, json={"approval": {"id": "apr_2", "status": "rejected"}})
    )
    assert tt.approvals.list(MB, status="pending")[0].id == "apr_1"
    assert tt.approvals.count(MB) == 3
    out = tt.approvals.approve(MB, "apr_1")
    assert out["approval"].status == "sent" and out["result"] == {"id": "m1"}
    assert "idempotency-key" in approve.calls.last.request.headers
    assert tt.approvals.reject(MB, "apr_2", note="no").status == "rejected"
    assert body_of(reject.calls.last.request) == {"note": "no"}
    assert "idempotency-key" not in reject.calls.last.request.headers
