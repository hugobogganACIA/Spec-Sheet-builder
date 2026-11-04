# ACIA Spec Sheet Builder

A small web app for storing, editing and publishing ACIA Aero Leasing aircraft
specification sheets.

1. **Upload the Excel tech spec** (the standard *Technical Specification* +
   *Avionic List* workbook). The app reads it and creates the aircraft, or adds a
   new version if that MSN already exists.
2. **Review and edit** every value in the browser: fields, tables, headings, page
   breaks, extra pages (LOPA, emergency equipment layout, drawings).
3. **Download the branded PDF**: cover page with contacts and disclaimer, the
   ACIA header and footer on each page, page numbers, and the avionics list and
   LOPA at the end.
4. **Make changes later** by uploading a new Excel file, editing directly, or
   typing a request in plain English such as *"LH engine TSN is now 8,450.20 and
   CSN 9,620"*. Every save is kept as a version, so you can see exactly what
   changed and restore any earlier version.

## Running it

### With Docker (recommended for a shared/team install)

```bash
docker compose up -d --build
```

Then open http://localhost:8000. Data (database + uploaded files) is stored in
`./data`; back this folder up.

To turn on plain-English changes, set an Anthropic API key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Locally (Python 3.11+)

```bash
pip install -r requirements.txt
```

```bash
playwright install chromium
```

```bash
uvicorn app.main:app --port 8000
```

## How the Excel file is read

The importer finds things by their **labels** in column A (e.g. `AIRCRAFT
REGISTRATION :`, `ENGINE ROTABLE - LIFE LIMITS`, `LANDING GEARS`), not by fixed
cell addresses. Rows can be added, removed or moved in the template without
breaking the import, as long as:

* labels stay in column A and values in columns B–G,
* blocks are separated by a blank row,
* section titles (`ENGINES`, `PROPELLERS`, `WEIGHTS`, `MAIN OPTIONS`) sit on
  their own row,
* the avionics sheet has a header row starting with `ATA`.

Values are shown the way Excel displays them (thousand separators, `FHs` and
`mths` suffixes). All dates use one style, `26 May 2026`. Cells holding Excel
errors such as `#VALUE!`, or a number where a component name should be, are
listed as warnings after upload so they can be fixed before the PDF goes out.
Images placed in the body of the sheet (for example the LOPA) are added as extra
pages automatically.

When an MSN that already exists is uploaded again, the new data replaces the old
values. Page-break and hide choices, the cover model name and any manually added
pages are kept. The upload summary lists every value that changed.

## Editing

* **Fields / Table / Text / Heading** blocks can be edited, reordered, hidden,
  or set to start on a new page. Rows and columns can be added or deleted.
* **Ask for a change** sends the sheet and your request to Claude, which proposes
  specific value changes. You see a was/now table before anything is applied,
  and nothing is saved until you press **Save**.
* **History** lists every version (Excel upload, manual edit, AI change, restore)
  with its changes, its PDF, and a Restore button.
* **Settings** holds the cover contacts, disclaimer, header and footer text used
  on every PDF.

## Project layout

```
app/
  main.py          FastAPI routes
  excel_import.py  Excel workbook -> spec document (JSON)
  render.py        spec -> PDF (HTML/CSS via headless Chromium, stitched with pypdf)
  ai_edit.py       plain-English edits via the Claude API (JSON-Pointer operations)
  diff.py          readable was/now change lists between versions
  store.py         SQLite storage, versions, uploaded files, settings
  templates/       cover, body and header/footer page templates
  static/          web UI (plain HTML/JS/CSS), logos, fonts
tests/
```

Run the tests with `pip install -r requirements-dev.txt` and then `pytest`. To
also check real workbooks, point `SPEC_SAMPLES` at a folder of `.xlsx` files:

```bash
SPEC_SAMPLES=/path/to/specs pytest
```

## Notes

* **Access control:** the app has no login of its own. Run it on the internal
  network, or behind the company's VPN or single sign-on proxy.
* **Fonts:** the PDFs use Inter (SIL Open Font License, bundled). It is a close,
  freely redistributable substitute for Aptos, which the original PowerPoint
  layouts used.
* **AI model:** defaults to `claude-opus-5-5`. Override it with
  `SPEC_AI_MODEL` if needed.

## Spec sheets tab in ACIA Commercial (runs on claude.ai)

The builder now lives in the ACIA Commercial artifact as its **Spec sheets** tab, after Pricing. It is a
framed module like Credit Lab: `artifact/build.py` writes `artifact/embed/m/specs.html`, which is published
to ACIA Commercial as `m/specs.html`. Its spec sheets, versions and settings are stored in ACIA Commercial's
database under `m/specs/...`, and images in that artifact's file store. It needs no server. PDFs are built
in the browser (pdfmake, Archivo, ACIA layout), and files that aren't the usual Excel template are read by
Claude through the viewer's account, with every value checked against the source. The earlier stand-alone
artifact was retired once its data had been copied into the tab.

* `artifact/src/core.js`: Excel import (same label-based rules as `app/excel_import.py`), diff, edits and the PDF layout
* `artifact/src/app.js`: the interface, storage, preview and download
* `artifact/src/normalize.js`: turns any workbook into one standard data shape and builds the standard layout from it. The usual template is read directly; other layouts are read by Claude, and every value is checked against the workbook cells
* `artifact/src/checks.js`: checks before sending: Excel errors, empty or TBD fields, overdue items, derived figures recalculated from the information date, and data age
* `artifact/src/shell.html`: styles and page markup
* `python3 artifact/build.py` assembles `artifact/spec-sheet-builder.html`, which is what gets published
