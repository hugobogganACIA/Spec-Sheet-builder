"""Assemble the single-file artifact page from src/ plus the logos and PDF fonts.

    python3 artifact/build.py   ->  artifact/spec-sheet-builder.html
"""
import base64
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE.parent / "app" / "static"


def data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


assets = {
    "logoWhite": data_uri(STATIC / "img" / "logo_white.png", "image/png"),
    "logoColor": data_uri(STATIC / "img" / "logo_color.png", "image/png"),
    # pdfmake virtual file system: file name -> base64
    "fonts": {f"Inter-{w}.ttf": base64.b64encode((STATIC / "fonts" / f"Inter-{w}.ttf").read_bytes()).decode()
              for w in ("Regular", "Bold", "Italic", "BoldItalic")},
}

src = HERE / "src"
page = "\n".join([
    (src / "shell.html").read_text(),
    f"<script>window.SPEC_ASSETS = {json.dumps(assets)};</script>",
    f"<script>\n{(src / 'core.js').read_text()}\n</script>",
    f"<script>\n{(src / 'app.js').read_text()}\n</script>",
])
out = HERE / "spec-sheet-builder.html"
out.write_text(page)
print(out, f"{len(page) / 1e6:.2f} MB")
