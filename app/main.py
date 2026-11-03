"""Spec Sheet Builder - web app and API.

Run:  uvicorn app.main:app --reload
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import ai_edit, render, store
from .diff import diff
from .excel_import import import_workbook, new_id

app = FastAPI(title="ACIA Spec Sheet Builder")
store.init()

MAX_UPLOAD = 40 * 1024 * 1024
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}


# ---------------------------------------------------------------- helpers

def _latest_or_404(aid: str) -> dict:
    v = store.latest_version(aid)
    if not store.get_aircraft(aid) or not v:
        raise HTTPException(404, "Aircraft not found")
    return v


def _layout_key(spec: dict) -> dict[tuple, dict]:
    keys, heading = {}, ""
    for s in spec.get("sections", []):
        if s["type"] == "heading":
            heading = s.get("title", "")
        keys[(s["type"], heading, s.get("title", ""))] = s
    return keys


def _merge_reimport(old: dict, new: dict) -> dict:
    """A re-uploaded Excel replaces the data but keeps layout choices and manual attachments."""
    old_keys = _layout_key(old)
    for key, s in _layout_key(new).items():
        if key in old_keys:
            s["page_break_before"] = old_keys[key].get("page_break_before", s["page_break_before"])
            s["hidden"] = old_keys[key].get("hidden", False)
    new["attachments"] = [a for a in old.get("attachments", []) if a.get("origin") != "excel"] + new["attachments"]
    if old.get("cover", {}).get("model"):
        new["cover"]["model"] = old["cover"]["model"]
    return new


def _pdf_filename(spec: dict) -> str:
    msn = spec.get("cover", {}).get("msn", "")
    when = dt.date.today().strftime("%b %y")
    return re.sub(r"[^\w .\-]", "", f"MSN {msn} Spec - {when}") + ".pdf"


def _render_cached(aid: str, version: dict) -> bytes:
    settings = store.get_settings()
    key = hashlib.sha256(
        json.dumps([version["id"], settings], sort_keys=True).encode() + render.TEMPLATE_HASH.encode()
    ).hexdigest()[:20]
    cache = store.DATA_DIR / "cache"
    cache.mkdir(exist_ok=True)
    f = cache / f"{aid}-{key}.pdf"
    if f.exists():
        return f.read_bytes()
    pdf = render.render_pdf(version["spec"], aid, settings)
    f.write_bytes(pdf)
    return pdf


def _read_upload(file: UploadFile) -> bytes:
    data = file.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File too large (max 40 MB)")
    return data


def _do_import(data: bytes, filename: str, aid: str | None) -> dict:
    try:
        result = import_workbook(data, filename)
    except Exception as e:  # openpyxl raises many types for bad files
        raise HTTPException(400, f"Could not read this Excel file: {e}") from e
    spec = result.spec
    msn = spec["cover"].get("msn") or ""
    created = False
    if aid is None:
        if not msn:
            raise HTTPException(400, "No AIRCRAFT SERIAL NUMBER found in the workbook.")
        aid = store.find_by_msn(msn)
        if aid is None:
            aid, created = store.create_aircraft(msn), True
    previous = store.latest_version(aid)

    for title, raw, ext in result.images:
        name = store.store_file(aid, raw, ext)
        spec["attachments"].append({"id": new_id(), "title": title, "kind": "image", "file": name,
                                    "origin": "excel", "hidden": False})
    if previous:
        spec = _merge_reimport(previous["spec"], spec)
        prev_msn = previous["spec"].get("cover", {}).get("msn")
        if prev_msn and msn and str(prev_msn) != str(msn):
            result.warnings.insert(0, f"This workbook is for MSN {msn} but the aircraft was MSN {prev_msn}.")
    changes = diff(previous["spec"] if previous else None, spec)
    vid = store.save_version(aid, spec, "Excel upload", filename)
    return {"aircraft_id": aid, "version_id": vid, "created": created, "warnings": result.warnings,
            "changes": changes if previous else [], "change_count": len(changes) if previous else 0}


# ---------------------------------------------------------------- API

@app.get("/api/config")
def config():
    return {"ai_enabled": ai_edit.available()}


@app.get("/api/aircraft")
def list_aircraft():
    return store.list_aircraft()


@app.post("/api/import")
def import_new(file: UploadFile = File(...)):
    return _do_import(_read_upload(file), file.filename or "", None)


@app.post("/api/aircraft/{aid}/import")
def import_into(aid: str, file: UploadFile = File(...)):
    _latest_or_404(aid)
    return _do_import(_read_upload(file), file.filename or "", aid)


@app.get("/api/aircraft/{aid}")
def get_aircraft(aid: str):
    v = _latest_or_404(aid)
    return {"id": aid, "version_id": v["id"], "updated_at": v["created_at"], "spec": v["spec"],
            "versions": store.list_versions(aid)}


@app.put("/api/aircraft/{aid}/spec")
def save_spec(aid: str, payload: dict = Body(...)):
    v = _latest_or_404(aid)
    spec = payload.get("spec")
    if not isinstance(spec, dict) or not isinstance(spec.get("sections"), list):
        raise HTTPException(400, "Invalid spec")
    if payload.get("base_version") and int(payload["base_version"]) != v["id"]:
        raise HTTPException(409, "Someone else saved a newer version. Reload to see it before saving.")
    changes = diff(v["spec"], spec)
    if not changes and json.dumps(spec, sort_keys=True) == json.dumps(v["spec"], sort_keys=True):
        return {"version_id": v["id"], "changes": []}
    source = payload.get("source") or "Manual edit"
    vid = store.save_version(aid, spec, source[:200], (payload.get("note") or "")[:500])
    return {"version_id": vid, "changes": changes}


@app.delete("/api/aircraft/{aid}")
def delete_aircraft(aid: str):
    _latest_or_404(aid)
    store.archive_aircraft(aid)
    return {"ok": True}


@app.get("/api/aircraft/{aid}/versions/{vid}")
def get_version(aid: str, vid: int):
    v = store.get_version(aid, vid)
    if not v:
        raise HTTPException(404, "Version not found")
    prev = None
    versions = store.list_versions(aid)
    older = [x["id"] for x in versions if x["id"] < vid]
    if older:
        prev = store.get_version(aid, max(older))
    return {**v, "changes": diff(prev["spec"] if prev else None, v["spec"]) if prev else []}


@app.post("/api/aircraft/{aid}/versions/{vid}/restore")
def restore_version(aid: str, vid: int):
    v = store.get_version(aid, vid)
    if not v:
        raise HTTPException(404, "Version not found")
    new_vid = store.save_version(aid, v["spec"], f"Restored version {vid}")
    return {"version_id": new_vid}


@app.post("/api/aircraft/{aid}/ai-edit")
def ai_edit_endpoint(aid: str, payload: dict = Body(...)):
    v = _latest_or_404(aid)
    instruction = (payload.get("instruction") or "").strip()
    if not instruction:
        raise HTTPException(400, "Please describe the change.")
    base = payload.get("spec") or v["spec"]
    try:
        result = ai_edit.propose(base, instruction)
    except ai_edit.AIEditError as e:
        raise HTTPException(400, str(e)) from e
    result["changes"] = diff(base, result["spec"])
    return result


@app.post("/api/aircraft/{aid}/attachments")
def upload_attachment(aid: str, file: UploadFile = File(...), title: str = Form("")):
    _latest_or_404(aid)
    data = _read_upload(file)
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext == "pdf":
        kind = "pdf"
    elif ext in IMAGE_EXT:
        kind = "image"
    else:
        raise HTTPException(400, "Attachments must be an image (PNG/JPG) or a PDF")
    name = store.store_file(aid, data, ext)
    default_title = re.sub(r"[_\-]+", " ", (file.filename or "").rsplit(".", 1)[0]).strip()
    return {"id": new_id(), "title": title or default_title, "kind": kind, "file": name,
            "origin": "upload", "hidden": False}


@app.get("/api/aircraft/{aid}/files/{name}")
def get_file(aid: str, name: str):
    try:
        p = store.file_path(aid, name)
    except ValueError as e:
        raise HTTPException(400, "Bad file name") from e
    if not p.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(p)


@app.get("/api/aircraft/{aid}/pdf")
def download_pdf(aid: str, version: int | None = None, inline: bool = False):
    v = store.get_version(aid, version) if version else _latest_or_404(aid)
    if not v:
        raise HTTPException(404, "Version not found")
    pdf = _render_cached(aid, v)
    disp = "inline" if inline else "attachment"
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'{disp}; filename="{_pdf_filename(v["spec"])}"'})


@app.post("/api/aircraft/{aid}/preview")
def preview_pdf(aid: str, payload: dict = Body(...)):
    _latest_or_404(aid)
    spec = payload.get("spec")
    if not isinstance(spec, dict):
        raise HTTPException(400, "Invalid spec")
    return Response(render.render_pdf(spec, aid), media_type="application/pdf")


@app.get("/api/settings")
def get_settings():
    return store.get_settings()


@app.put("/api/settings")
def put_settings(payload: dict = Body(...)):
    return store.save_settings(payload)


app.mount("/", StaticFiles(directory=render.STATIC, html=True), name="static")
