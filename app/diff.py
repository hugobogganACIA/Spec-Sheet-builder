"""Human-readable differences between two spec versions."""
from __future__ import annotations


def _flatten(spec: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    cover = spec.get("cover", {})
    for k in ("model", "msn", "year"):
        out[f"Cover › {k.upper() if k == 'msn' else k.title()}"] = str(cover.get(k, ""))
    heading = ""
    for s in spec.get("sections", []):
        t = s.get("type")
        if t == "heading":
            heading = s.get("title", "")
            continue
        name = s.get("title") or heading or "Section"
        if t == "kv":
            seen: dict[str, int] = {}
            for r in s.get("rows", []):
                label = r.get("label", "")
                seen[label] = seen.get(label, 0) + 1
                key = label if seen[label] == 1 else f"{label} #{seen[label]}"
                out[f"{name} › {key}"] = r.get("value", "")
        elif t == "grid":
            cols = list(s.get("columns", []))
            groups = []
            for g in s.get("groups", []):
                groups += [g.get("label", "")] * int(g.get("span", 1))
            seen = {}
            for i, r in enumerate(s.get("rows", [])):
                cells = r.get("cells", [])
                label = r.get("label", "")
                if "AVIONIC" in name.upper():
                    label = f"{cells[0] if cells else ''} ({label})"
                seen[label] = seen.get(label, 0) + 1
                rk = label if seen[label] == 1 else f"{label} #{seen[label]}"
                for j, c in enumerate(cells):
                    col = cols[j] if j < len(cols) else f"col {j + 1}"
                    if j < len(groups) and groups[j]:
                        col = f"{groups[j]} {col}"
                    out[f"{name} › {rk} › {col}"] = c
        elif t == "list":
            for i, it in enumerate(s.get("items", [])):
                out[f"{name} › line {i + 1}"] = it.get("text", "")
    for a in spec.get("attachments", []):
        out[f"Attachment › {a.get('title') or a.get('file')}"] = "hidden" if a.get("hidden") else "shown"
    return out


def diff(old: dict | None, new: dict) -> list[dict]:
    a = _flatten(old or {})
    b = _flatten(new)
    changes = []
    for k, v in b.items():
        if k not in a:
            if v not in ("", None):
                changes.append({"field": k, "old": "", "new": v, "kind": "added"})
        elif a[k] != v:
            changes.append({"field": k, "old": a[k], "new": v, "kind": "changed"})
    for k, v in a.items():
        if k not in b and v not in ("", None):
            changes.append({"field": k, "old": v, "new": "", "kind": "removed"})
    return changes
