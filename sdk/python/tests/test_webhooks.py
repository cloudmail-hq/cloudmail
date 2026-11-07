import pytest

from cloudmail import WebhookVerificationError, sign_webhook, verify_webhook

# Vectors produced by the server's signer (shared/webhooks.ts `signWebhook`).
SECRET = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
TS = 1793059200
BODY = (
    '{"id":"evt_1","type":"message.received","created_at":"2026-10-27T00:00:00.000Z",'
    '"mailbox":"support@example.com","data":{"id":"m1","subject":"Hi ✓"}}'
)
BODY_SIG = "v1=6fdd771f8f974ef2e6519907a8c1c30ec56752d3eeb12b067b7fe6cac72df768"
EMPTY_SIG = "v1=2506f3d663603affe43e5062872df8aa9a3cf7347139786c82ca46130f0adf92"


def headers(sig, ts=TS):
    return {"X-Tapetide-Signature": sig, "X-Tapetide-Timestamp": str(ts)}


def test_signer_matches_server_vectors():
    assert sign_webhook(SECRET, TS, BODY) == BODY_SIG
    assert sign_webhook(SECRET, TS, BODY.encode("utf-8")) == BODY_SIG
    assert sign_webhook(SECRET, TS, "") == EMPTY_SIG


def test_verify_returns_parsed_payload_for_bytes_and_str():
    for raw in (BODY, BODY.encode("utf-8")):
        payload = verify_webhook(raw, headers(BODY_SIG), SECRET, now=TS + 10)
        assert payload["type"] == "message.received"
        assert payload["data"]["subject"] == "Hi ✓"


def test_header_lookup_is_case_insensitive():
    lower = {"x-tapetide-signature": BODY_SIG, "x-tapetide-timestamp": str(TS)}
    assert verify_webhook(BODY, lower, SECRET, now=TS)["id"] == "evt_1"


def test_accepts_any_of_several_signatures():
    sig = f"v1={'0' * 64}, {BODY_SIG}"
    assert verify_webhook(BODY, headers(sig), SECRET, now=TS)["id"] == "evt_1"


def test_empty_body_vector():
    assert verify_webhook("", headers(EMPTY_SIG), SECRET, now=TS) is None


def test_rejects_tampered_body():
    with pytest.raises(WebhookVerificationError, match="mismatch"):
        verify_webhook(BODY.replace("Hi", "Ho"), headers(BODY_SIG), SECRET, now=TS)


def test_rejects_wrong_secret():
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, headers(BODY_SIG), SECRET + "x", now=TS)


def test_rejects_changed_timestamp():
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, headers(BODY_SIG, TS + 1), SECRET, now=TS)


def test_tolerance_window():
    assert verify_webhook(BODY, headers(BODY_SIG), SECRET, now=TS + 300)
    assert verify_webhook(BODY, headers(BODY_SIG), SECRET, now=TS - 300)
    with pytest.raises(WebhookVerificationError, match="tolerance"):
        verify_webhook(BODY, headers(BODY_SIG), SECRET, now=TS + 301)
    with pytest.raises(WebhookVerificationError, match="tolerance"):
        verify_webhook(BODY, headers(BODY_SIG), SECRET, now=TS + 1000, tolerance=600)


def test_missing_headers():
    with pytest.raises(WebhookVerificationError, match="Signature"):
        verify_webhook(BODY, {"X-Tapetide-Timestamp": str(TS)}, SECRET, now=TS)
    with pytest.raises(WebhookVerificationError, match="Timestamp"):
        verify_webhook(BODY, {"X-Tapetide-Signature": BODY_SIG}, SECRET, now=TS)
    with pytest.raises(WebhookVerificationError, match="Invalid"):
        verify_webhook(BODY, headers(BODY_SIG, "soon"), SECRET, now=TS)
    with pytest.raises(WebhookVerificationError, match="secret"):
        verify_webhook(BODY, headers(BODY_SIG), "", now=TS)
