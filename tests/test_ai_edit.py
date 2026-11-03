import json

import anthropic
import httpx2 as httpx

from app.ai_edit import propose

SPEC = {
    "cover": {"model": "ATR72-600", "msn": "1072", "year": "2013"},
    "sections": [{"id": "a", "type": "kv", "title": "General Description", "page_break_before": False,
                  "hidden": False, "rows": [{"label": "AIRCRAFT REGISTRATION", "value": "M-EDEL"}]}],
    "attachments": [],
}


def test_propose_sends_structured_request_and_applies_ops():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["beta"] = request.headers.get("anthropic-beta", "")
        answer = {"summary": "Registration updated.", "ops": [
            {"op": "replace", "path": "/sections/0/rows/0/value", "value_json": json.dumps("D2-BFC")}]}
        return httpx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": json.dumps(answer)}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 10},
        })

    client = anthropic.Anthropic(api_key="test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = propose(SPEC, "Registration is now D2-BFC", client=client)

    assert result["spec"]["sections"][0]["rows"][0]["value"] == "D2-BFC"
    assert SPEC["sections"][0]["rows"][0]["value"] == "M-EDEL"  # original untouched
    assert seen["body"]["model"] == "claude-opus-5-5"
    assert seen["body"]["output_config"]["format"]["type"] == "json_schema"
    assert seen["body"]["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in seen["beta"]
