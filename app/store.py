"""SQLite storage: aircraft, their spec versions, attachments and settings.

Every save creates a new version, so nothing is ever overwritten and any
earlier state can be restored.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("SPEC_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "specs.db"
FILES_DIR = DATA_DIR / "files"

DEFAULT_SETTINGS = {
    "company": "ACIA Aero Leasing",
    "doc_title": "Specifications & Summary of Terms",
    "confidential": "STRICTLY PRIVATE AND CONFIDENTIAL",
    "contacts_heading": "For Additional Summary, Please Contact:",
    "contacts": [
        {"name": "Mark Dunnachie", "title": "SVP Commercial",
         "email": "mark.dunnachie@aciaeroleasing.com", "phone": "+33 7 88 95 09 58"},
        {"name": "Patrick O’Reilly", "title": "Commercial Director",
         "email": "patrick.oreilly@aciaaeroleasing.com", "phone": "+353 86 234 9457"},
        {"name": "Hugo Boggan", "title": "Commercial Manager",
         "email": "hugo.boggan@aciaaeroleasing.com", "phone": "+353 87 350 7876"},
    ],
    "disclaimer": (
        "This summary has been prepared by ACIA Aero Leasing for information purposes only. While the "
        "information herein is believed to be accurate, ACIA has not independently verified any of the "
        "information or statements contained herein and expressly disclaims any liability for this "
        "information. Nothing contained herein constitutes either an offer or invitation to purchase any "
        "shares, other securities, capital or assets, or to enter into any agreement or arrangement in "
        "relation to any kind of transaction with ACIA or its shareholders, nor should it be taken as a "
        "recommendation to enter into any transaction with such parties. The information contained in this "
        "summary is not intended to provide the basis of any investment decision. ACIA reserves the right "
        "without advance notice to negotiate with one or more prospective investors or change the procedure "
        "for the transaction or to terminate negotiations at any time prior to the signing of any binding "
        "agreement"
    ),
}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS aircraft (
                id TEXT PRIMARY KEY,
                msn TEXT NOT NULL,
                created_at TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
                created_at TEXT NOT NULL,
                source TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                spec TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS versions_aircraft ON versions(aircraft_id, id);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------- aircraft

def list_aircraft() -> list[dict]:
    with connect() as db:
        rows = db.execute(
            """
            SELECT a.id, a.msn, a.created_at, v.id AS version_id, v.created_at AS updated_at,
                   v.source, v.spec
            FROM aircraft a
            JOIN versions v ON v.id = (SELECT MAX(id) FROM versions WHERE aircraft_id = a.id)
            WHERE a.archived = 0
            ORDER BY CAST(a.msn AS INTEGER), a.msn
            """
        ).fetchall()
    out = []
    for r in rows:
        spec = json.loads(r["spec"])
        out.append({
            "id": r["id"], "msn": r["msn"], "updated_at": r["updated_at"], "version_id": r["version_id"],
            "last_change": r["source"], "model": spec.get("cover", {}).get("model", ""),
            "registration": find_value(spec, "AIRCRAFT REGISTRATION"),
            "info_date": find_value(spec, "INFORMATION DATE"),
        })
    return out


def find_value(spec: dict, label: str) -> str:
    for s in spec.get("sections", []):
        if s.get("type") == "kv":
            for row in s.get("rows", []):
                if row.get("label", "").upper() == label.upper():
                    return row.get("value", "")
    return ""


def find_by_msn(msn: str) -> str | None:
    with connect() as db:
        r = db.execute("SELECT id FROM aircraft WHERE msn = ? AND archived = 0", (str(msn),)).fetchone()
    return r["id"] if r else None


def create_aircraft(msn: str) -> str:
    aid = uuid.uuid4().hex[:12]
    with connect() as db:
        db.execute("INSERT INTO aircraft (id, msn, created_at) VALUES (?, ?, ?)", (aid, str(msn), _now()))
    return aid


def archive_aircraft(aid: str) -> None:
    with connect() as db:
        db.execute("UPDATE aircraft SET archived = 1 WHERE id = ?", (aid,))


def get_aircraft(aid: str) -> dict | None:
    with connect() as db:
        r = db.execute("SELECT * FROM aircraft WHERE id = ?", (aid,)).fetchone()
    return dict(r) if r else None


# ---------------------------------------------------------------- versions

def save_version(aid: str, spec: dict, source: str, note: str = "") -> int:
    msn = spec.get("cover", {}).get("msn")
    with connect() as db:
        cur = db.execute(
            "INSERT INTO versions (aircraft_id, created_at, source, note, spec) VALUES (?, ?, ?, ?, ?)",
            (aid, _now(), source, note, json.dumps(spec)),
        )
        if msn:
            db.execute("UPDATE aircraft SET msn = ? WHERE id = ?", (str(msn), aid))
        return cur.lastrowid


def latest_version(aid: str) -> dict | None:
    with connect() as db:
        r = db.execute(
            "SELECT * FROM versions WHERE aircraft_id = ? ORDER BY id DESC LIMIT 1", (aid,)
        ).fetchone()
    return _version(r)


def get_version(aid: str, vid: int) -> dict | None:
    with connect() as db:
        r = db.execute("SELECT * FROM versions WHERE aircraft_id = ? AND id = ?", (aid, vid)).fetchone()
    return _version(r)


def list_versions(aid: str) -> list[dict]:
    with connect() as db:
        rows = db.execute(
            "SELECT id, created_at, source, note FROM versions WHERE aircraft_id = ? ORDER BY id DESC", (aid,)
        ).fetchall()
    return [dict(r) for r in rows]


def _version(r) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["spec"] = json.loads(d["spec"])
    return d


# ---------------------------------------------------------------- files

def attachment_dir(aid: str) -> Path:
    p = FILES_DIR / aid
    p.mkdir(parents=True, exist_ok=True)
    return p


def store_file(aid: str, data: bytes, ext: str) -> str:
    fid = uuid.uuid4().hex[:12]
    name = f"{fid}.{ext.lower().lstrip('.')}"
    (attachment_dir(aid) / name).write_bytes(data)
    return name


def file_path(aid: str, name: str) -> Path:
    p = (attachment_dir(aid) / name).resolve()
    if p.parent != attachment_dir(aid).resolve():
        raise ValueError("bad file name")
    return p


# ---------------------------------------------------------------- settings

def get_settings() -> dict:
    with connect() as db:
        rows = db.execute("SELECT key, value FROM settings").fetchall()
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    for r in rows:
        out[r["key"]] = json.loads(r["value"])
    return out


def save_settings(values: dict) -> dict:
    with connect() as db:
        for k, v in values.items():
            if k in DEFAULT_SETTINGS:
                db.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )
    return get_settings()
