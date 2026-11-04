"""Assemble the spec sheet builder page from src/ plus the logos, fonts and illustrations.

    python3 artifact/build.py   ->  artifact/embed/m/specs.html  (ACIA Commercial's "Spec sheets" tab)
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
    # cover illustrations by aircraft type: data URI + width/height ratio
    "aircraft": {},
    # pdfmake virtual file system: file name -> base64
    "fonts": {f"Archivo-{w}.ttf": base64.b64encode((STATIC / "fonts" / f"Archivo-{w}.ttf").read_bytes()).decode()
              for w in ("Regular", "Bold", "Italic", "BoldItalic", "SemiExpanded-SemiBold", "Expanded-Bold")},
}

from PIL import Image  # noqa: E402

assets["engines"] = {}
for kind, bucket in (("aircraft", "aircraft"), ("engine", "engines")):
    for img in sorted((HERE / "img").glob(f"{kind}-*.png")):
        with Image.open(img) as im:
            ratio = im.width / im.height
        assets[bucket][img.stem.split("-", 1)[1]] = {"src": data_uri(img, "image/png"), "ratio": round(ratio, 4)}

src = HERE / "src"
page = "\n".join([
    (src / "shell.html").read_text(),
    f"<script>window.SPEC_ASSETS = {json.dumps(assets)};</script>",
    f"<script>\n{(src / 'core.js').read_text()}\n</script>",
    f"<script>\n{(src / 'normalize.js').read_text()}\n</script>",
    f"<script>\n{(src / 'checks.js').read_text()}\n</script>",
    f"<script>\n{(src / 'app.js').read_text()}\n</script>",
])
# The builder lives in ACIA Commercial as its framed "Spec sheets" tab (published there as m/specs.html,
# its data under m/specs/...). The separate stand-alone artifact was retired on 4 Nov 2026.
framed = HERE / "embed" / "m" / "specs.html"
framed.parent.mkdir(parents=True, exist_ok=True)
framed.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8">'
                  '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + page + "</body></html>")
print(framed, f"{len(page) / 1e6:.2f} MB")
