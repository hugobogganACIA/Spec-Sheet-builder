"""Importer tests against a synthetic workbook laid out like the ACIA tech-spec template.

Set SPEC_SAMPLES=/path/to/folder to also run the importer over real workbooks.
"""
import datetime as dt
import io
import os
from pathlib import Path

import openpyxl
import pytest

from app.excel_import import format_value, import_workbook


def build_workbook() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Technical Specification"
    ws.merge_cells("C1:G1")
    ws["C1"] = "MSN 9999 AIRCRAFT TECHNICAL SPECIFICATIONS"
    ws["C2"] = "ACIA AERO LEASING"
    general = [
        ("INFORMATION DATE :", dt.datetime(2026, 9, 11), "[$-409]d\\-mmm\\-yy;@"),
        ("AIRCRAFT TYPE :", "72-212A (600)", "General"),
        ("DATE OF MANUFACTURE :", dt.datetime(2013, 2, 19), "dd\\-mmm\\-yy"),
        ("AIRFRAME TOTAL TIME :", 10113.57, "#,##0.00"),
        ("AIRCRAFT REGISTRATION :", "M-TEST", "General"),
        ("AIRCRAFT SERIAL NUMBER :", 9999, "General"),
    ]
    for i, (k, v, f) in enumerate(general, start=4):
        ws.cell(i, 1, k)
        ws.cell(i, 2, v).number_format = f
    ws.merge_cells("A14:G14")
    ws["A14"] = "ENGINES"
    ws["A15"], ws["B15"] = "MANUFACTURER :", "Pratt & Whitney  "
    ws.merge_cells("B18:C18")
    ws.merge_cells("E18:F18")
    ws["B18"], ws["E18"] = "LH ENGINE (No 1)", "RH ENGINE (No 2)"
    ws["A19"], ws["B19"], ws["E19"] = "MANUFACTURER SERIAL NUMBER:", "PCE-1", "PCE-2"
    ws["B21"], ws["C21"], ws["E21"], ws["F21"] = "Turbomachinery", "RGB", "Turbomachinery", "RGB"
    ws["A22"], ws["B22"], ws["C22"], ws["E22"], ws["F22"] = "TIME SINCE OVERHAUL (TSO):", 0, 0, 12.5, 12.5
    ws["A24"] = "ENGINE ROTABLE - LIFE LIMITS"
    ws.merge_cells("B24:D24")
    ws.merge_cells("E24:G24")
    ws["B24"], ws["E24"] = "LH ENGINE (No 1)", "RH ENGINE (No 2)"
    for c, t in zip("BCDEFG", ["Limit", "CSN", "Remaining"] * 2):
        ws[f"{c}25"] = t
    ws["A26"] = "PT DISK STG 1"
    for c, v in zip("BCDEFG", [30000, 9308, 20692, 30000, 100, 29900]):
        ws[f"{c}26"] = v
        ws[f"{c}26"].number_format = "#,##0"
    ws["A28"] = "WEIGHTS"
    ws["A30"], ws["B30"] = "UNIT :", "KG"
    ws["A32"], ws["D32"], ws["F32"] = "MAXIMUM TAKE-OFF WEIGHT :", "MTOW :", 23000
    ws["A35"] = "MAIN OPTIONS"
    ws["A37"] = "ATA 23"
    ws["A38"] = "Cockpit Door Surveillance System (SB 72-23-1076)"
    ws["N8"] = "For automatic calculation - don't modify"  # helper column must be ignored

    av = wb.create_sheet("AVIONIC LIST")
    for c, t in zip("ABCDEFG", ["ATA", "Components", "P/N", "S/N", "Manufacturer", "Type", "FIN"]):
        av[f"{c}8"] = t
    av.append([23, "SSCVR", "2100-1020-02", "000841827", "L3", "FA2100", "1RK"])
    av.append([34, "GNSS 1", "#VALUE!", "134", "THALES", "TOPSTAR", "155SN1"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.fixture(scope="module")
def result():
    return import_workbook(build_workbook(), "test.xlsx")


def sections(result, kind):
    return [s for s in result.spec["sections"] if s["type"] == kind]


def test_cover(result):
    assert result.spec["cover"] == {"model": "ATR72-600", "msn": "9999", "year": "2013"}


def test_general_block(result):
    general = sections(result, "kv")[0]
    values = {r["label"]: r["value"] for r in general["rows"]}
    assert values["INFORMATION DATE"] == "11 Sep 2026"
    assert values["AIRFRAME TOTAL TIME"] == "10,113.57"
    assert values["AIRCRAFT SERIAL NUMBER"] == "9999"


def test_headings(result):
    assert [s["title"] for s in sections(result, "heading")] == ["ENGINES", "WEIGHTS", "MAIN OPTIONS"]


def test_engine_tables(result):
    grids = sections(result, "grid")
    summary, modules, llp = grids[0], grids[1], grids[2]
    assert summary["columns"] == ["LH ENGINE (No 1)", "RH ENGINE (No 2)"]
    assert modules["groups"] == [{"label": "LH ENGINE (No 1)", "span": 2}, {"label": "RH ENGINE (No 2)", "span": 2}]
    assert llp["title"] == "ENGINE ROTABLE - LIFE LIMITS"
    assert llp["rows"][0] == {"label": "PT DISK STG 1", "cells": ["30,000", "9,308", "20,692", "30,000", "100", "29,900"]}


def test_weights_and_options(result):
    weights = [s for s in sections(result, "kv") if any("MTOW" in r["label"] for r in s["rows"])][0]
    assert weights["rows"] == [{"label": "MAXIMUM TAKE-OFF WEIGHT (MTOW)", "value": "23,000 KG"}]
    items = sections(result, "list")[0]["items"]
    assert items[0] == {"text": "ATA 23", "bold": True}


def test_avionics_and_warnings(result):
    av = sections(result, "grid")[-1]
    assert av["title"] == "Avionics / Technical Attributes"
    assert av["rows"][0]["cells"][0] == "SSCVR"
    assert any("#VALUE!" in w for w in result.warnings)


@pytest.mark.parametrize("value,fmt,expected", [
    (10500, '#,##0\\ "FHs"', "10,500 FHs"),
    (3156.04, '#,##0.##\\ "FHs"', "3,156.04 FHs"),
    (10500, '#,##0.##\\ "FHs"', "10,500 FHs"),
    (84, '#,##0.00\\ "mths"', "84.00 mths"),
    (13.2867, "0.00", "13.29"),
    (13043.478, "#,##0", "13,043"),
    (1060, "General", "1060"),
])
def test_format_value(value, fmt, expected):
    assert format_value(value, fmt) == expected


SAMPLES = os.environ.get("SPEC_SAMPLES")


@pytest.mark.skipif(not SAMPLES, reason="set SPEC_SAMPLES to a folder of real workbooks")
def test_real_samples():
    files = list(Path(SAMPLES).glob("*.xlsx"))
    assert files
    for f in files:
        r = import_workbook(f.read_bytes(), f.name)
        assert r.spec["cover"]["msn"], f
        assert len(r.spec["sections"]) > 10, f
