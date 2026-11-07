import httpx
import pytest
import respx

from cloudmail import StreamRevoked, Tapetide, parse_sse

BASE = "https://mail.example.com"


def lines(text):
    return text.split("\n")


def test_parser_frames_comments_and_controls():
    stream = (
        "retry: 3000\n"
        ": connected latest_id=7\n"
        "\n"
        "id: 8\n"
        "event: message.received\n"
        'data: {"id":"evt_8","type":"message.received"}\n'
        "\n"
        ": keepalive\n"
        "\n"
        "event: subscription_revoked\n"
        'data: {"mailbox":"a@x.com"}\n'
        "\n"
        "id: 9\n"
        "event: message.sent\n"
        "data: {\"a\":\n"
        "data: 1}\n"
        "\n"
        "id: 10\n"
        "event: partial"
    )
    frames = list(parse_sse(lines(stream)))
    assert [f.event for f in frames] == ["message.received", "subscription_revoked", "message.sent"]
    assert frames[0].id == "8" and frames[0].json()["id"] == "evt_8"
    assert frames[1].is_control and frames[1].id is None
    assert frames[1].json() == {"mailbox": "a@x.com"}
    assert frames[2].data == '{"a":\n1}' and frames[2].json() == {"a": 1}


def test_parser_handles_crlf_and_no_space_after_colon():
    frames = list(parse_sse(["id:3\r", "event:x\r", "data:{}\r", "\r"]))
    assert frames[0].id == "3" and frames[0].event == "x" and frames[0].json() == {}


def sse_body(*frames):
    return ("".join(frames)).encode("utf-8")


def event(id, type="message.received"):
    return f'id: {id}\nevent: {type}\ndata: {{"id":"evt_{id}","type":"{type}"}}\n\n'


@respx.mock
def test_iter_sse_reconnects_with_last_event_id():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, content=sse_body(": hi\n\n", event(1), event(2)))
        return httpx.Response(200, content=sse_body(event(3)))

    respx.get(f"{BASE}/api/v1/events/sse").mock(side_effect=handler)
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    got = []
    for ev in tt.events.iter_sse(mailboxes=["a@x.com"], events=["message.received"], max_reconnects=1):
        got.append(ev.id)
        if len(got) == 3:
            break
    assert got == [1, 2, 3]
    first, second = calls[0], calls[1]
    assert first.url.params.get_list("mailbox") == ["a@x.com"]
    assert first.url.params.get_list("event") == ["message.received"]
    assert "since" not in first.url.params and "last-event-id" not in first.headers
    assert second.url.params["since"] == "2" and second.headers["last-event-id"] == "2"


@respx.mock
def test_iter_sse_reconnects_after_transport_error():
    state = {"n": 0}

    def handler(request):
        state["n"] += 1
        if state["n"] == 1:
            raise httpx.ConnectError("boom")
        return httpx.Response(200, content=sse_body(event(5)))

    respx.get(f"{BASE}/api/v1/events/sse").mock(side_effect=handler)
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    it = tt.events.iter_sse(since=4, max_reconnects=3)
    assert next(it).id == 5


@respx.mock
def test_iter_sse_stops_on_credential_revoked():
    body = sse_body(event(1), "event: credential_revoked\ndata: {}\n\n", event(2))
    respx.get(f"{BASE}/api/v1/events/sse").mock(return_value=httpx.Response(200, content=body))
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    seen = []
    with pytest.raises(StreamRevoked):
        for ev in tt.events.iter_sse():
            seen.append(ev.id)
    assert seen == [1]


@respx.mock
def test_iter_sse_stops_on_401():
    respx.get(f"{BASE}/api/v1/events/sse").mock(return_value=httpx.Response(401, json={"error": "nope"}))
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    with pytest.raises(StreamRevoked):
        next(tt.events.iter_sse())


@respx.mock
def test_iter_sse_subscription_revoked_continues():
    body = sse_body(event(1), 'event: subscription_revoked\ndata: {"mailbox":"a@x.com"}\n\n', event(2))
    respx.get(f"{BASE}/api/v1/events/sse").mock(return_value=httpx.Response(200, content=body))
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    controls = []
    ids = [e.id for e in tt.events.iter_sse(max_reconnects=0, on_control=lambda f: controls.append(f.json()))]
    assert ids == [1, 2]
    assert controls == [{"mailbox": "a@x.com"}]


@respx.mock
def test_iter_sse_replay_truncated_resumes_from_cursor():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, content=sse_body(event(1), 'event: replay_truncated\ndata: {"resume_from":40}\n\n'))
        return httpx.Response(200, content=sse_body(event(41)))

    respx.get(f"{BASE}/api/v1/events/sse").mock(side_effect=handler)
    tt = Tapetide(BASE, "ttk_x", sleep=lambda s: None)
    it = tt.events.iter_sse(max_reconnects=2)
    assert next(it).id == 1
    assert next(it).id == 41
    assert calls[1].url.params["since"] == "40"
