"""Natural-language edits ("update LH engine TSN to 8,450.20") via the Claude API.

Claude never rewrites the whole document. It returns a small list of
JSON-Pointer operations, which we apply to a copy of the spec and show to the
user as a diff before anything is saved.
"""
from __future__ import annotations

import copy
import json
import os

MODEL = os.environ.get("SPEC_AI_MODEL", "claude-opus-5-5")

SYSTEM = """You edit aircraft technical specification sheets for ACIA Aero Leasing.

You receive the current spec document as JSON and an instruction from a member of the
commercial team. Respond with the smallest set of JSON-Pointer (RFC 6901) operations
that carries out the instruction.

Document structure:
- /cover: {model, msn, year} - the cover page.
- /sections/N: one block of the PDF, in print order. Types:
  - heading: {title}
  - kv: {title, rows: [{label, value}]}
  - grid: {title, label_header, groups: [{label, span}], columns: [...],
           rows: [{label, cells: [...]}]}  - cells[i] belongs to columns[i].
  - list: {title, items: [{text, bold}]}
  Every section also has page_break_before and hidden booleans.
- /attachments/N: {title, kind, file, hidden} - extra pages such as the LOPA.

Rules:
- All values are display strings. Match the formatting already used in the same row or
  column (thousand separators, decimals, units such as "FHs" or "mths", date style
  like "26 May 2026").
- Only change what the instruction asks for. If one change implies another value
  that is shown in the sheet (for example a new CSN changes "Remaining" = Limit - CSN),
  update that too and say so in the summary.
- ops: "replace" an existing value, "add" a new array element (use "/-" to append),
  "remove" an element. value_json is the new value encoded as JSON (e.g. "\\"8,450.20\\"",
  or an object for a new row). Leave value_json empty for "remove".
- When an instruction is ambiguous or refers to something that is not in the sheet,
  return no ops and explain in the summary what is unclear."""

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One or two sentences describing the change."},
        "ops": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["replace", "add", "remove"]},
                    "path": {"type": "string"},
                    "value_json": {"type": "string"},
                },
                "required": ["op", "path", "value_json"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "ops"],
    "additionalProperties": False,
}


class AIEditError(Exception):
    pass


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


# ---------------------------------------------------------------- JSON pointer

def _parts(path: str) -> list[str]:
    if not path.startswith("/"):
        raise AIEditError(f"Invalid path {path!r}")
    return [p.replace("~1", "/").replace("~0", "~") for p in path[1:].split("/")]


def _walk(doc, parts):
    cur = doc
    for p in parts:
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
    return cur


def apply_ops(spec: dict, ops: list[dict]) -> dict:
    doc = copy.deepcopy(spec)
    for op in ops:
        parts = _parts(op["path"])
        if not parts or parts[0] not in ("cover", "sections", "attachments"):
            raise AIEditError(f"Edits outside the spec are not allowed: {op['path']}")
        parent = _walk(doc, parts[:-1])
        key = parts[-1]
        kind = op["op"]
        value = json.loads(op["value_json"]) if op.get("value_json") else None
        try:
            if kind == "replace":
                if isinstance(parent, list):
                    parent[int(key)] = value
                else:
                    if key not in parent:
                        raise AIEditError(f"Nothing to replace at {op['path']}")
                    parent[key] = value
            elif kind == "add":
                if isinstance(parent, list):
                    parent.insert(len(parent) if key == "-" else int(key), value)
                else:
                    parent[key] = value
            elif kind == "remove":
                if isinstance(parent, list):
                    parent.pop(int(key))
                else:
                    parent.pop(key)
            else:
                raise AIEditError(f"Unknown op {kind}")
        except (IndexError, KeyError, ValueError) as e:
            raise AIEditError(f"Could not apply {kind} at {op['path']}: {e}") from e
    return doc


# ---------------------------------------------------------------- Claude call

def propose(spec: dict, instruction: str, client=None) -> dict:
    """Return {summary, ops, spec} - the proposed (unsaved) spec."""
    import anthropic

    if client is None:
        if not available():
            raise AIEditError("AI edits are not configured: set ANTHROPIC_API_KEY on the server.")
        client = anthropic.Anthropic()
    doc = {k: spec.get(k) for k in ("cover", "sections", "attachments")}
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{
                "role": "user",
                "content": f"<spec>\n{json.dumps(doc, ensure_ascii=False)}\n</spec>\n\n"
                           f"<instruction>\n{instruction}\n</instruction>",
            }],
        )
    except anthropic.RateLimitError as e:
        raise AIEditError("The AI service is busy, please try again in a minute.") from e
    except anthropic.APIStatusError as e:
        raise AIEditError(f"AI request failed ({e.status_code}): {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise AIEditError("Could not reach the AI service.") from e

    if response.stop_reason == "refusal":
        raise AIEditError("The AI declined this request. Please make the change manually.")
    if response.stop_reason == "max_tokens":
        raise AIEditError("The change was too large for one request - try splitting it up.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        raise AIEditError("The AI returned an unreadable answer, please try again.") from e
    new_spec = apply_ops(spec, result.get("ops", []))
    return {"summary": result.get("summary", ""), "ops": result.get("ops", []), "spec": new_spec}
