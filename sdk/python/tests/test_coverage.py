"""Every operation in openapi.json has a client method, or a reason it has none in EXCLUDED.

Rather than trusting names, this calls every public method of every resource
with placeholder arguments against a catch-all mock, and maps each request
(method and path) back to an operation in the spec. A method that calls a
route the spec does not have fails too. The spec is the one the TypeScript
SDK generates from workers/lib/openapi.ts (sdk/typescript/openapi.json).
"""

import inspect
import json
import re
import types
from pathlib import Path
from urllib.parse import unquote

import httpx
import pytest
import respx

from cloudmail import Tapetide

SPEC = Path(__file__).resolve().parents[2] / "typescript" / "openapi.json"

#: Operations an API token cannot use, so the SDK leaves them out.
EXCLUDED = {
    # A browser session that re-confirmed its password or passkey in the last 15 minutes.
    "putCloudflareConnection": "browser session with recent re-authentication (403 session_required for tokens)",
    "deleteCloudflareConnection": "browser session with recent re-authentication (403 session_required for tokens)",
    "verifyCloudflareConnection": "browser session with recent re-authentication (403 session_required for tokens)",
    "applyCloudflareSetup": "browser session with recent re-authentication (403 session_required for tokens)",
    "revertCloudflareChange": "browser session with recent re-authentication (403 session_required for tokens)",
    "deleteAccount": "browser session with recent re-authentication (403 session_required for tokens)",
    "createAccountExport": "browser session with recent re-authentication (403 session_required for tokens)",
    # Licence changes are session-only.
    "activateLicence": "browser session only (403 session_required for tokens)",
    "deactivateLicence": "browser session only (403 session_required for tokens)",
    # Web Push devices belong to a browser.
    "listPushSubscriptions": "per-browser Web Push device (409 no_identity for tokens)",
    "createPushSubscription": "per-browser Web Push device (409 no_identity for tokens)",
    "deletePushSubscription": "per-browser Web Push device (409 no_identity for tokens)",
    "getPushPreferences": "per-browser Web Push device (409 no_identity for tokens)",
    "updatePushPreferences": "per-browser Web Push device (409 no_identity for tokens)",
    "sendTestPush": "per-browser Web Push device (409 no_identity for tokens)",
    # AI provider and routing changes need a person in the app.
    "createAiProvider": "person only (403 person_required for tokens and OAuth apps)",
    "updateAiProvider": "person only (403 person_required for tokens and OAuth apps)",
    "deleteAiProvider": "person only (403 person_required for tokens and OAuth apps)",
    "updateAiProviderModels": "person only (403 person_required for tokens and OAuth apps)",
    "updateAiRouting": "person only (403 person_required for tokens and OAuth apps)",
    "updateWorkersAiRouting": "person only (403 person_required for tokens and OAuth apps)",
    # The WebSocket stream; Python follows events over SSE (events.iter_sse).
    "streamEvents": "WebSocket transport; the Python client uses the SSE stream (events.iter_sse) instead",
}

#: Arguments a placeholder cannot satisfy.
OVERRIDES = {
    ("mail", "send"): {"text": "t"},
    ("mail", "reply"): {"text": "t"},
    ("mail", "forward"): {"text": "t"},
    ("imports", "upload_part"): {"part": 1, "content": b"x"},
    ("mailboxes", "update"): {"settings": {"fromName": "x"}},
    ("suppressions", "add"): {"entries": {"email": "x"}},
    ("events", "iter_sse"): {"max_reconnects": 0},
}


def _routes():
    spec = json.loads(SPEC.read_text())
    out = []
    for path, item in spec["paths"].items():
        for method in ("get", "post", "put", "patch", "delete"):
            op = item.get(method, {}).get("operationId")
            if not op:
                continue
            segs = path.split("/")
            pattern = "/".join("[^/]+" if re.fullmatch(r"\{.+\}", s) else re.escape(s) for s in segs)
            literals = sum(1 for s in segs if not s.startswith("{"))
            out.append((op, method.upper(), re.compile(f"^{pattern}$"), literals))
    # The most specific template wins: /approvals/count before /approvals/{id}.
    return sorted(out, key=lambda r: -r[3])


ROUTES = _routes()


def _operation_for(method, raw_path):
    # Encoded segments (%40, %2F) are one segment; decode only what cannot add a slash.
    path = re.sub(r"%(?!2F)[0-9A-Fa-f]{2}", lambda m: unquote(m.group(0)), raw_path)
    for op, m, rx, _ in ROUTES:
        if m == method and rx.match(path):
            return op
    return None


def _placeholder(param):
    name = param.name
    if name in ("ids", "label_ids", "events", "recipients", "steps", "conditions", "actions", "zones", "addresses", "aliases", "entries"):
        return ["x"]
    return "x"


BODY = {
    "id": "x", "email": "x", "name": "x", "url": "x", "events": [], "status": "sent",
    "approval": {"id": "x", "status": "sent"}, "approvals": [], "pending": 0,
    "webhook": {"id": "x", "name": "x", "url": "x", "events": []}, "webhooks": [],
    "delivery": None, "deliveries": [], "agent_inbox": {"address": "x"}, "agent_inboxes": [],
    "address": "x", "token": {"id": "x"}, "emails": [], "totalCount": 0, "aliases": [],
}


def _exercise():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.raw_path.decode().split("?")[0]))
        if request.url.path.endswith("/events/sse"):
            return httpx.Response(401, json={"error": "revoked"})
        return httpx.Response(200, json=BODY)

    covered, unmatched = {}, []
    with respx.mock(assert_all_called=False) as mock:
        mock.route().mock(side_effect=handler)
        client = Tapetide("https://mail.example.com", "ttk_test_secret", max_retries=0, sleep=lambda s: None)
        for attr, resource in vars(client).items():
            if attr.startswith("_") or not hasattr(resource, "_client"):
                continue
            for name, fn in inspect.getmembers(resource, inspect.ismethod):
                if name.startswith("_"):
                    continue
                kwargs, args = dict(OVERRIDES.get((attr, name), {})), []
                for p in inspect.signature(fn).parameters.values():
                    if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) or p.default is not p.empty or p.name in kwargs:
                        continue
                    if p.kind == p.KEYWORD_ONLY:
                        kwargs[p.name] = _placeholder(p)
                    else:
                        args.append(_placeholder(p))
                try:
                    result = fn(*args, **kwargs)
                    if isinstance(result, types.GeneratorType):
                        next(result, None)
                except Exception:
                    pass  # the request is what counts; a placeholder body may not parse
                for method, path in seen:
                    op = _operation_for(method, path)
                    if op:
                        covered.setdefault(op, f"{attr}.{name}")
                    else:
                        unmatched.append(f"{attr}.{name}: {method} {path}")
                seen.clear()
        client.close()
    return covered, unmatched


@pytest.fixture(scope="module")
def exercised():
    return _exercise()


def test_every_operation_has_a_method_or_an_exclusion(exercised):
    covered, unmatched = exercised
    assert unmatched == [], "methods calling routes the spec does not have"
    missing = [op for op, *_ in ROUTES if op not in covered and op not in EXCLUDED]
    assert missing == [], "operations without a client method: add one, or an EXCLUDED entry with a reason"


def test_exclusions_are_real_and_unused(exercised):
    covered, _ = exercised
    ids = {op for op, *_ in ROUTES}
    for op, reason in EXCLUDED.items():
        assert op in ids, f"{op} is not in openapi.json"
        assert op not in covered, f"{op} is excluded but {covered.get(op)} calls it"
        assert len(reason) > 10
