"""Turn an ACIA technical-specification workbook into a spec document.

The workbook layout (label in column A, values in B..G, blank rows between
blocks) is read by *labels*, not fixed cell addresses, so rows can be added or
moved in the Excel template without breaking the import.

A spec document is plain JSON:

    {
      "cover":   {"model": "ATR72-600", "msn": "1060", "year": "2012"},
      "sections": [ {id, type, title, ...}, ... ],
      "attachments": [ ... ],            # added later (LOPA etc.)
      "source": {"filename": ..., "info_date": ...}
    }

Section types:
    heading  {title}
    kv       {title, rows: [{label, value}]}
    grid     {title, label_header, groups: [{label, span}], columns: [..],
              rows: [{label, cells: [..]}]}
    list     {title, items: [{text, bold}]}

All values are stored as display strings, formatted the way Excel shows them,
so what you edit is exactly what prints.
"""
from __future__ import annotations

import datetime as dt
import io
import re
import uuid
from dataclasses import dataclass, field

import openpyxl
from openpyxl.utils import get_column_letter

ERROR_VALUES = {"#VALUE!", "#REF!", "#DIV/0!", "#N/A", "#NAME?", "#NUM!", "#NULL!"}
KNOWN_HEADINGS = {"ENGINES", "PROPELLERS", "WEIGHTS", "MAIN OPTIONS", "LANDING GEARS"}
MAX_COL = 7  # A..G hold the spec; columns further right are helper cells
DATE_FORMAT = "%d %b %Y"


def new_id() -> str:
    return uuid.uuid4().hex[:8]


# --------------------------------------------------------------------------
# Value formatting (mimics Excel number formats)
# --------------------------------------------------------------------------

def format_value(value, number_format: str = "General") -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return re.sub(r"\s{2,}", " ", value).strip()
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (dt.datetime, dt.date)):
        # One house date style across the whole sheet (Excel mixes d-mmm-yy,
        # mm-dd-yy and d mmm yyyy, which reads badly side by side).
        return value.strftime(DATE_FORMAT)
    if isinstance(value, (int, float)):
        fmt = (number_format or "General").split(";")[0]
        suffix = ""
        m = re.search(r'"([^"]*)"', fmt)
        if m:
            suffix = " " + m.group(1).strip()
            fmt = fmt[: m.start()]
        fmt = fmt.replace("\\", "").strip()
        thousands = "," in fmt
        if "." in fmt:
            decimals = fmt.split(".", 1)[1]
            required = decimals.count("0")
            optional = decimals.count("#")
            places = required + optional
            text = f"{value:,.{places}f}" if thousands else f"{value:.{places}f}"
            if optional and "." in text:
                keep = len(text.split(".")[0]) + 1 + required
                text = text[:keep].rstrip(".") if required == 0 else text
                if required == 0:
                    frac = f"{value:.{places}f}".split(".")[1].rstrip("0")
                    text = text + ("." + frac if frac else "")
        elif fmt.startswith("#") or fmt.startswith("0"):
            text = f"{round(value):,}" if thousands else f"{round(value)}"
        else:  # General
            if float(value).is_integer():
                text = str(int(value))
            else:
                text = f"{value:.2f}".rstrip("0").rstrip(".")
        return text + suffix
    return str(value)


# --------------------------------------------------------------------------
# Sheet reading helpers
# --------------------------------------------------------------------------

@dataclass
class Row:
    r: int
    cells: dict[int, object]  # col -> raw value
    fmts: dict[int, str]

    def text(self, c: int) -> str:
        return format_value(self.cells.get(c), self.fmts.get(c, "General"))

    @property
    def a(self) -> str:
        return self.text(1)

    @property
    def value_cols(self) -> list[int]:
        return sorted(c for c in self.cells if c > 1)


@dataclass
class ImportResult:
    spec: dict
    warnings: list[str] = field(default_factory=list)
    images: list[tuple[str, bytes, str]] = field(default_factory=list)  # (title, data, ext)


def _blank(v) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _read_rows(ws, max_col: int) -> list[Row]:
    rows = []
    for r in range(1, ws.max_row + 1):
        cells, fmts = {}, {}
        for c in range(1, max_col + 1):
            cell = ws.cell(r, c)
            if not _blank(cell.value):
                cells[c] = cell.value
                fmts[c] = cell.number_format
        rows.append(Row(r, cells, fmts))
    return rows


def _blocks(rows: list[Row]) -> list[list[Row]]:
    blocks, cur = [], []
    for row in rows:
        if row.cells:
            cur.append(row)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    return blocks


def _merged_span(ws, r: int, c: int) -> tuple[int, int] | None:
    for rng in ws.merged_cells.ranges:
        if rng.min_row <= r <= rng.max_row and rng.min_col <= c <= rng.max_col:
            return rng.min_col, rng.max_col
    return None


def _clean_label(s: str) -> str:
    return re.sub(r"\s*:\s*$", "", s).strip()


def _is_kv_row(row: Row) -> bool:
    if not row.a:
        return False
    vals = [row.text(c) for c in row.value_cols]
    if not vals:
        return True
    if row.a.rstrip().endswith(":") and len(vals) == 1:
        return True
    return any(v.endswith(":") for v in vals)


def _kv_pairs(row: Row) -> list[dict]:
    """'LABEL : | value | OTHER: | value2' -> [{label, value}, ...]"""
    pairs = [{"label": _clean_label(row.a), "value": ""}]
    for c in row.value_cols:
        t = row.text(c)
        if t.endswith(":"):
            pairs.append({"label": _clean_label(t), "value": ""})
        else:
            pairs[-1]["value"] = (pairs[-1]["value"] + " " + t).strip()
    # "MAXIMUM TAKE-OFF WEIGHT :" + "MTOW :" 23000  ->  one row with abbreviation
    merged = []
    for p in pairs:
        if merged and not merged[-1]["value"] and len(p["label"]) <= 6:
            merged[-1] = {"label": f"{merged[-1]['label']} ({p['label']})", "value": p["value"]}
        else:
            merged.append(p)
    return merged


def _is_header_row(row: Row, first: bool, next_row: Row | None) -> bool:
    if not row.value_cols:
        return False
    raw = [row.cells[c] for c in row.value_cols]
    if not all(isinstance(v, str) for v in raw):
        return False
    if any(row.text(c).endswith(":") for c in row.value_cols):
        return False
    if not row.a:
        return True
    if not first or len(raw) < 2:
        return False
    return next_row is not None and bool(next_row.value_cols)


# --------------------------------------------------------------------------
# Technical specification sheet
# --------------------------------------------------------------------------

def _parse_spec_sheet(ws, warnings: list[str]) -> tuple[list[dict], dict]:
    rows = _read_rows(ws, MAX_COL)
    title_row_limit = 3  # rows 1-2 are the sheet title / logo
    blocks = [b for b in _blocks(rows) if b[0].r > title_row_limit]
    sections: list[dict] = []
    general: dict[str, str] = {}
    current_heading = None
    prev_grid_headers: dict[int, tuple[int, int, str]] | None = None
    in_options = False
    weight_unit = None

    for block in blocks:
        first = block[0]
        # ---- heading rows (single cell in A, known name or merged across) ----
        if not first.value_cols and (
            first.a.upper() in KNOWN_HEADINGS or (_merged_span(ws, first.r, 1) or (1, 1))[1] >= 4
        ):
            current_heading = first.a.strip()
            in_options = current_heading.upper() == "MAIN OPTIONS"
            sections.append({"id": new_id(), "type": "heading", "title": current_heading.upper()})
            prev_grid_headers = None
            block = block[1:]
            if not block:
                continue
            first = block[0]

        # ---- free text lists (MAIN OPTIONS, LOPA notes) ----
        if all(not r.value_cols for r in block) and (in_options or len(block) > 1):
            items = [{"text": r.a, "bold": i == 0} for i, r in enumerate(block)]
            if sections and sections[-1]["type"] == "list":
                sections[-1]["items"].extend(items)
            else:
                sections.append({"id": new_id(), "type": "list", "title": "", "items": items})
            continue

        i = 0
        kv_rows: list[dict] = []
        while i < len(block) and _is_kv_row(block[i]) and not (
            i == 0 and _is_header_row(block[i], True, block[i + 1] if i + 1 < len(block) else None)
        ):
            kv_rows.extend(_kv_pairs(block[i]))
            i += 1
        if kv_rows:
            unit_row = next((k for k in kv_rows if k["label"].upper() == "UNIT"), None)
            if unit_row:
                weight_unit = unit_row["value"]
                kv_rows = [k for k in kv_rows if k is not unit_row]
            if weight_unit and current_heading and current_heading.upper() == "WEIGHTS":
                for k in kv_rows:
                    if re.fullmatch(r"\d+(\.\d+)?", k["value"]):
                        k["value"] = f"{float(k['value']):,.0f} {weight_unit}"
            if current_heading is None:
                for k in kv_rows:
                    general[k["label"].upper()] = k["value"]
            if kv_rows:
                if sections and sections[-1]["type"] == "kv" and sections[-1].get("_heading") == current_heading:
                    sections[-1]["rows"].extend(kv_rows)
                else:
                    sections.append({
                        "id": new_id(), "type": "kv",
                        "title": "General Description" if current_heading is None else "",
                        "rows": kv_rows, "_heading": current_heading,
                    })
        rest = block[i:]
        if not rest:
            continue

        # ---- grid ----
        headers: list[Row] = []
        j = 0
        while j < len(rest) and _is_header_row(rest[j], j == 0, rest[j + 1] if j + 1 < len(rest) else None):
            headers.append(rest[j])
            j += 1
        data = rest[j:]
        cols = sorted({c for r in rest for c in r.value_cols})
        if not cols:
            continue
        col_header = headers[-1] if headers else None
        group_header = headers[-2] if len(headers) >= 2 else None

        def header_text(hrow: Row | None, c: int) -> str:
            if hrow is None:
                return ""
            if c in hrow.cells:
                return hrow.text(c)
            span = _merged_span(ws, hrow.r, c)
            if span and span[0] in hrow.cells:
                return hrow.text(span[0])
            return ""

        columns = [header_text(col_header, c) for c in cols]
        title = ""
        for h in headers:
            if h.a:
                title = _clean_label(h.a)
        groups = []
        group_src = group_header
        if group_src is None and prev_grid_headers and len(headers) == 1 and not col_header.a:
            # e.g. the Turbomachinery/RGB table inherits LH/RH ENGINE from the table above
            groups = _groups_from_spans(cols, prev_grid_headers)
        elif group_src is not None:
            spans = {}
            for c in group_src.value_cols:
                span = _merged_span(ws, group_src.r, c) or (c, c)
                spans[c] = (span[0], span[1], group_src.text(c))
            groups = _groups_from_spans(cols, spans)

        grid_rows = []
        for r in data:
            cells = [r.text(c) for c in cols]
            for c in cols:
                if isinstance(r.cells.get(c), str) and r.cells[c].strip() in ERROR_VALUES:
                    warnings.append(
                        f"{ws.title}!{get_column_letter(c)}{r.r} contains an Excel error ({r.cells[c].strip()})"
                    )
            grid_rows.append({"label": _clean_label(r.a), "cells": cells})

        # Remember merged header spans so the next table can inherit groups
        if col_header is not None and len(headers) == 1:
            spans = {}
            for c in col_header.value_cols:
                span = _merged_span(ws, col_header.r, c) or (c, c)
                spans[c] = (span[0], span[1], col_header.text(c))
            prev_grid_headers = spans if any(s[1] > s[0] for s in spans.values()) else None

        sections.append({
            "id": new_id(), "type": "grid", "title": title, "label_header": "",
            "groups": groups, "columns": columns, "rows": grid_rows,
        })

    for s in sections:
        s.pop("_heading", None)
    return sections, general


def _groups_from_spans(cols: list[int], spans: dict[int, tuple[int, int, str]]) -> list[dict]:
    groups = []
    for c in cols:
        label = ""
        for lo, hi, text in spans.values():
            if lo <= c <= hi:
                label = text
        if groups and groups[-1]["label"] == label and label:
            groups[-1]["span"] += 1
        else:
            groups.append({"label": label, "span": 1})
    if all(not g["label"] for g in groups):
        return []
    return groups


# --------------------------------------------------------------------------
# Avionics sheet
# --------------------------------------------------------------------------

def _parse_avionics(ws, warnings: list[str]) -> dict | None:
    rows = _read_rows(ws, MAX_COL)
    header = next((r for r in rows if r.a.upper() == "ATA" and len(r.value_cols) >= 3), None)
    if header is None:
        return None
    cols = header.value_cols
    out = []
    bad = 0
    for r in rows[header.r:]:  # rows after the header (header.r is 1-based)
        if not r.a and 2 not in r.cells:
            break
        cells = []
        for c in cols:
            v = r.cells.get(c)
            if isinstance(v, str) and v.strip() in ERROR_VALUES:
                bad += 1
                warnings.append(f"{ws.title}!{get_column_letter(c)}{r.r} contains an Excel error ({v.strip()})")
            elif c == 2 and isinstance(v, (int, float)):
                warnings.append(
                    f"{ws.title}!B{r.r}: component name is a number ({format_value(v)}) - "
                    "probably a broken formula, please check"
                )
            cells.append(r.text(c))
        out.append({"label": r.a, "cells": cells})
    return {
        "id": new_id(), "type": "grid", "title": "Avionics / Technical Attributes",
        "label_header": header.a, "groups": [], "columns": [header.text(c) for c in cols], "rows": out,
    }


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

def _cover_from_general(general: dict[str, str]) -> dict:
    ac_type = general.get("AIRCRAFT TYPE", "")
    model = ac_type
    m = re.search(r"(\d{2})-\d+\w*\s*\((\d{3})\)", ac_type)
    if m:
        model = f"ATR{m.group(1)}-{m.group(2)}"
    year = ""
    dom = general.get("DATE OF MANUFACTURE", "")
    ym = re.search(r"(\d{4})", dom) or re.search(r"(\d{2})$", dom)
    if ym:
        year = ym.group(1) if len(ym.group(1)) == 4 else "20" + ym.group(1)
    return {"model": model, "msn": general.get("AIRCRAFT SERIAL NUMBER", ""), "year": year}


def _set_layout_defaults(sections: list[dict]) -> None:
    """Default page breaks, mirroring the current ACIA PDF layout."""
    for s in sections:
        s.setdefault("page_break_before", False)
        s.setdefault("hidden", False)
        title = (s.get("title") or "").upper()
        if s["type"] == "heading" and title in {"PROPELLERS"}:
            s["page_break_before"] = True
        if s["type"] == "grid" and title in {"LANDING GEARS", "AVIONICS / TECHNICAL ATTRIBUTES"}:
            s["page_break_before"] = True


def import_workbook(data: bytes, filename: str = "") -> ImportResult:
    warnings: list[str] = []
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    spec_ws = next((ws for ws in wb.worksheets if "SPEC" in ws.title.upper()), wb.worksheets[0])
    sections, general = _parse_spec_sheet(spec_ws, warnings)

    av_ws = next((ws for ws in wb.worksheets if "AVIONIC" in ws.title.upper()), None)
    if av_ws is not None:
        av = _parse_avionics(av_ws, warnings)
        if av and av["rows"]:
            sections.append(av)

    _set_layout_defaults(sections)

    images: list[tuple[str, bytes, str]] = []
    for ws in wb.worksheets:
        for img in getattr(ws, "_images", []):
            try:
                row = img.anchor._from.row
            except AttributeError:
                continue
            if row < 5:  # logo in the sheet header
                continue
            raw = img._data()
            ext = (getattr(img, "format", None) or "png").lower()
            images.append(("LOPA" if "SPEC" in ws.title.upper() else ws.title, raw, ext))

    if not general:
        warnings.append("Could not find the general information block (INFORMATION DATE, AIRCRAFT TYPE, ...)")

    spec = {
        "cover": _cover_from_general(general),
        "sections": sections,
        "attachments": [],
        "source": {"filename": filename, "info_date": general.get("INFORMATION DATE", "")},
    }
    return ImportResult(spec=spec, warnings=warnings, images=images)
