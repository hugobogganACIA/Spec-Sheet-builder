"""Spec document -> branded ACIA PDF.

Pipeline (all HTML/CSS rendered by headless Chromium, stitched with pypdf):

  1. cover.html        -> 1 full-bleed cover page
  2. body.html         -> N content pages (tables flow and paginate naturally)
  3. PDF attachments   -> each page scaled into the content area
  4. chrome.html       -> header + footer + page number for every page after the cover,
                          merged underneath the content pages
"""
from __future__ import annotations

import hashlib
import io
import os
import tempfile
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from pypdf import PageObject, PdfReader, PdfWriter, Transformation

from . import store

APP_DIR = Path(__file__).resolve().parent
STATIC = APP_DIR / "static"
PAGE_W, PAGE_H = 540, 780  # points - same page size as the existing ACIA spec PDFs
CONTENT_BOX = (32, 58, 508, 694)  # x0, y0, x1, y1 (PDF coordinates, origin bottom-left)

# Changes to the templates invalidate cached PDFs.
TEMPLATE_HASH = hashlib.sha256(
    b"".join(p.read_bytes() for p in sorted((APP_DIR / "templates").glob("*.html")))
).hexdigest()[:12]

env = Environment(loader=FileSystemLoader(APP_DIR / "templates"), autoescape=select_autoescape(["html"]))


def _ctx(spec: dict, settings: dict) -> dict:
    cover = spec.get("cover", {})
    return {
        "spec": spec,
        "cover": cover,
        "settings": settings,
        "static": STATIC.as_uri(),
        "page_w": PAGE_W,
        "page_h": PAGE_H,
        "footer_label": f"{settings['company']} | MSN {cover.get('msn', '')}",
    }


def render_html(spec: dict, settings: dict, aid: str | None, part: str) -> str:
    ctx = _ctx(spec, settings)
    if part == "body":
        images = []
        for att in spec.get("attachments", []):
            if att.get("hidden") or att.get("kind") != "image" or not aid:
                continue
            p = store.file_path(aid, att["file"])
            if p.exists():
                images.append({**att, "src": p.as_uri()})
        ctx["image_attachments"] = images
    return env.get_template(f"{part}.html").render(**ctx)


def _chromium():
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    exe = os.environ.get("CHROMIUM_PATH")
    if not exe and Path("/opt/pw-browsers/chromium").exists():
        exe = "/opt/pw-browsers/chromium"
    browser = pw.chromium.launch(executable_path=exe or None, args=["--no-sandbox"])
    return pw, browser


def _html_to_pdf(page, html: str, workdir: Path, name: str) -> bytes:
    f = workdir / f"{name}.html"
    f.write_text(html, encoding="utf-8")
    page.goto(f.as_uri(), wait_until="load")
    page.evaluate("document.fonts.ready")
    return page.pdf(
        width=f"{PAGE_W / 72}in", height=f"{PAGE_H / 72}in", print_background=True, prefer_css_page_size=True,
    )


def _fit_into_content(src: PageObject) -> PageObject:
    """Place an uploaded PDF page (e.g. a LOPA drawing) inside the content area."""
    box = src.mediabox
    sw, sh = float(box.width), float(box.height)
    x0, y0, x1, y1 = CONTENT_BOX
    scale = min((x1 - x0) / sw, (y1 - y0) / sh)
    tx = x0 + ((x1 - x0) - sw * scale) / 2 - float(box.left) * scale
    ty = y1 - sh * scale - float(box.bottom) * scale  # top-aligned
    blank = PageObject.create_blank_page(width=PAGE_W, height=PAGE_H)
    blank.merge_transformed_page(src, Transformation().scale(scale).translate(tx, ty))
    return blank


def render_pdf(spec: dict, aid: str | None = None, settings: dict | None = None) -> bytes:
    settings = settings or store.get_settings()
    pw, browser = _chromium()
    try:
        page = browser.new_page()
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            cover_pdf = _html_to_pdf(page, render_html(spec, settings, aid, "cover"), tmpdir, "cover")
            body_pdf = _html_to_pdf(page, render_html(spec, settings, aid, "body"), tmpdir, "body")

            content_pages = list(PdfReader(io.BytesIO(body_pdf)).pages)
            for att in spec.get("attachments", []):
                if att.get("hidden") or att.get("kind") != "pdf" or not aid:
                    continue
                p = store.file_path(aid, att["file"])
                if p.exists():
                    for src in PdfReader(str(p)).pages:
                        content_pages.append(_fit_into_content(src))

            ctx = _ctx(spec, settings)
            ctx["pages"] = list(range(2, len(content_pages) + 2))
            chrome_html = env.get_template("chrome.html").render(**ctx)
            chrome_pages = PdfReader(io.BytesIO(_html_to_pdf(page, chrome_html, tmpdir, "chrome"))).pages
    finally:
        browser.close()
        pw.stop()

    out = PdfWriter()
    out.add_page(PdfReader(io.BytesIO(cover_pdf)).pages[0])
    for chrome, content in zip(chrome_pages, content_pages):
        chrome.merge_page(content)
        out.add_page(chrome)
    cover = spec.get("cover", {})
    out.add_metadata({
        "/Title": f"MSN {cover.get('msn', '')} {cover.get('model', '')} - {settings['doc_title']}",
        "/Author": settings["company"],
    })
    buf = io.BytesIO()
    out.write(buf)
    return buf.getvalue()
