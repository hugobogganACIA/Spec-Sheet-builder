/* ===== Spec core: Excel import, formatting, diff, edits, PDF definition =====
   Pure functions; needs XLSX (SheetJS) for import and nothing else. */
(function (root) {
  "use strict";
  const ERROR_VALUES = new Set(["#VALUE!", "#REF!", "#DIV/0!", "#N/A", "#NAME?", "#NUM!", "#NULL!"]);
  const KNOWN_HEADINGS = new Set(["ENGINES", "PROPELLERS", "WEIGHTS", "MAIN OPTIONS", "LANDING GEARS"]);
  const MAX_COL = 7; // A..G hold the spec; helper cells further right are ignored
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const newId = () => Math.random().toString(16).slice(2, 10);
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDate = (y, m, d) => `${pad2(d)} ${MONTHS[m - 1]} ${y}`;
  const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());

  function withCommas(s) {
    const neg = s.startsWith("-");
    const [i, f] = (neg ? s.slice(1) : s).split(".");
    const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + g + (f !== undefined ? "." + f : "");
  }

  /** Format a number the way Excel shows it with `fmt` (the subset used in tech specs). */
  function formatNumber(value, fmt) {
    fmt = (fmt || "General").split(";")[0];
    let suffix = "";
    const m = fmt.match(/"([^"]*)"/);
    if (m) { suffix = " " + m[1].trim(); fmt = fmt.slice(0, m.index); }
    fmt = fmt.replace(/\\/g, "").trim();
    const thousands = fmt.includes(",");
    let text;
    if (fmt.includes(".")) {
      const dec = fmt.split(".")[1];
      const req = (dec.match(/0/g) || []).length;
      const opt = (dec.match(/#/g) || []).length;
      text = value.toFixed(req + opt);
      if (opt) {
        let [i, f] = text.split(".");
        f = f.replace(/0+$/, "");
        if (f.length < req) f = f.padEnd(req, "0");
        text = f ? `${i}.${f}` : i;
      }
      if (thousands) text = withCommas(text);
    } else if (/^[#0]/.test(fmt)) {
      text = String(Math.round(value));
      if (thousands) text = withCommas(text);
    } else {
      text = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    }
    return text + suffix;
  }

  function cellText(cell) {
    if (!cell || isBlank(cell.v)) return "";
    if (cell.t === "e") return cell.w || "#ERROR";
    if (cell.t === "s" || cell.t === "str") return String(cell.v).replace(/\s{2,}/g, " ").trim();
    if (cell.t === "b") return cell.v ? "Yes" : "No";
    if (cell.t === "d" && cell.v instanceof Date) return fmtDate(cell.v.getFullYear(), cell.v.getMonth() + 1, cell.v.getDate());
    if (cell.t === "n") {
      const XLSX = root.XLSX;
      if (cell.z && XLSX && XLSX.SSF.is_date(cell.z)) {
        const d = XLSX.SSF.parse_date_code(cell.v);
        return fmtDate(d.y, d.m, d.d);
      }
      return formatNumber(cell.v, cell.z || "General");
    }
    return String(cell.v);
  }

  // ---------------------------------------------------------------- sheet helpers
  function readRows(ws) {
    const XLSX = root.XLSX;
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const rows = [];
    for (let r = 0; r <= range.e.r; r++) {
      const cells = {};
      for (let c = 0; c < MAX_COL; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && !isBlank(cell.v)) cells[c + 1] = cell;
      }
      rows.push(makeRow(r + 1, cells));
    }
    return rows;
  }

  function makeRow(r, cells) {
    const row = {
      r, cells,
      text: (c) => cellText(cells[c]),
      get a() { return cellText(cells[1]); },
      get valueCols() { return Object.keys(cells).map(Number).filter((c) => c > 1).sort((x, y) => x - y); },
    };
    return row;
  }

  function blocks(rows) {
    const out = []; let cur = [];
    for (const row of rows) {
      if (Object.keys(row.cells).length) cur.push(row);
      else if (cur.length) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function mergedSpan(ws, r, c) { // 1-based in, 1-based out
    for (const m of ws["!merges"] || []) {
      if (m.s.r + 1 <= r && r <= m.e.r + 1 && m.s.c + 1 <= c && c <= m.e.c + 1) return [m.s.c + 1, m.e.c + 1];
    }
    return null;
  }

  const cleanLabel = (s) => s.replace(/\s*:\s*$/, "").trim();
  const isStr = (cell) => cell && (cell.t === "s" || cell.t === "str");

  function isKvRow(row) {
    if (!row.a) return false;
    const vals = row.valueCols.map((c) => row.text(c));
    if (!vals.length) return true;
    if (row.a.trim().endsWith(":") && vals.length === 1) return true;
    return vals.some((v) => v.endsWith(":"));
  }

  function kvPairs(row) {
    const pairs = [{ label: cleanLabel(row.a), value: "" }];
    for (const c of row.valueCols) {
      const t = row.text(c);
      if (t.endsWith(":")) pairs.push({ label: cleanLabel(t), value: "" });
      else pairs[pairs.length - 1].value = (pairs[pairs.length - 1].value + " " + t).trim();
    }
    const merged = [];
    for (const p of pairs) {
      const last = merged[merged.length - 1];
      if (last && !last.value && p.label.length <= 6) merged[merged.length - 1] = { label: `${last.label} (${p.label})`, value: p.value };
      else merged.push(p);
    }
    return merged;
  }

  function isHeaderRow(row, first, next) {
    const cols = row.valueCols;
    if (!cols.length) return false;
    if (!cols.every((c) => isStr(row.cells[c]))) return false;
    if (cols.some((c) => row.text(c).endsWith(":"))) return false;
    if (!row.a) return true;
    if (!first || cols.length < 2) return false;
    return !!next && next.valueCols.length > 0;
  }

  function groupsFromSpans(cols, spans) {
    const groups = [];
    for (const c of cols) {
      let label = "";
      for (const [lo, hi, text] of spans) if (lo <= c && c <= hi) label = text;
      const last = groups[groups.length - 1];
      if (last && label && last.label === label) last.span++;
      else groups.push({ label, span: 1 });
    }
    return groups.every((g) => !g.label) ? [] : groups;
  }

  function spansOf(ws, hrow) {
    return hrow.valueCols.map((c) => { const s = mergedSpan(ws, hrow.r, c) || [c, c]; return [s[0], s[1], hrow.text(c)]; });
  }

  // ---------------------------------------------------------------- spec sheet
  function parseSpecSheet(ws, sheetName, warnings) {
    const rows = readRows(ws);
    const bl = blocks(rows).filter((b) => b[0].r > 3);
    const sections = [];
    const general = {};
    let heading = null, prevSpans = null, inOptions = false, unit = null;

    for (let block of bl) {
      let first = block[0];
      const span = mergedSpan(ws, first.r, 1);
      if (!first.valueCols.length && (KNOWN_HEADINGS.has(first.a.toUpperCase()) || (span && span[1] >= 4))) {
        heading = first.a.trim();
        inOptions = heading.toUpperCase() === "MAIN OPTIONS";
        sections.push({ id: newId(), type: "heading", title: heading.toUpperCase() });
        prevSpans = null;
        block = block.slice(1);
        if (!block.length) continue;
        first = block[0];
      }
      if (block.every((r) => !r.valueCols.length) && (inOptions || block.length > 1)) {
        const items = block.map((r, i) => ({ text: r.a, bold: i === 0 }));
        const last = sections[sections.length - 1];
        if (last && last.type === "list") last.items.push(...items);
        else sections.push({ id: newId(), type: "list", title: "", items });
        continue;
      }

      let i = 0; let kv = [];
      while (i < block.length && isKvRow(block[i]) && !(i === 0 && isHeaderRow(block[i], true, block[i + 1]))) {
        kv.push(...kvPairs(block[i])); i++;
      }
      if (kv.length) {
        const unitRow = kv.find((k) => k.label.toUpperCase() === "UNIT");
        if (unitRow) { unit = unitRow.value; kv = kv.filter((k) => k !== unitRow); }
        if (unit && heading && heading.toUpperCase() === "WEIGHTS") {
          for (const k of kv) if (/^\d+(\.\d+)?$/.test(k.value)) k.value = `${withCommas(String(Math.round(+k.value)))} ${unit}`;
        }
        if (heading === null) for (const k of kv) general[k.label.toUpperCase()] = k.value;
        if (kv.length) {
          const last = sections[sections.length - 1];
          if (last && last.type === "kv" && last._heading === heading) last.rows.push(...kv);
          else sections.push({ id: newId(), type: "kv", title: heading === null ? "General Description" : "", rows: kv, _heading: heading });
        }
      }
      const rest = block.slice(i);
      if (!rest.length) continue;

      const headers = []; let j = 0;
      while (j < rest.length && isHeaderRow(rest[j], j === 0, rest[j + 1])) { headers.push(rest[j]); j++; }
      const data = rest.slice(j);
      const cols = [...new Set(rest.flatMap((r) => r.valueCols))].sort((x, y) => x - y);
      if (!cols.length) continue;
      const colHeader = headers[headers.length - 1] || null;
      const groupHeader = headers.length >= 2 ? headers[headers.length - 2] : null;
      const headerText = (h, c) => {
        if (!h) return "";
        if (h.cells[c]) return h.text(c);
        const s = mergedSpan(ws, h.r, c);
        return s && h.cells[s[0]] ? h.text(s[0]) : "";
      };
      const columns = cols.map((c) => headerText(colHeader, c));
      let title = "";
      for (const h of headers) if (h.a) title = cleanLabel(h.a);
      let groups = [];
      if (!groupHeader && prevSpans && headers.length === 1 && !colHeader.a) groups = groupsFromSpans(cols, prevSpans);
      else if (groupHeader) groups = groupsFromSpans(cols, spansOf(ws, groupHeader));

      const gridRows = data.map((r) => {
        for (const c of cols) {
          const cell = r.cells[c];
          if (cell && (cell.t === "e" || (isStr(cell) && ERROR_VALUES.has(String(cell.v).trim())))) {
            warnings.push(`${sheetName}!${colLetter(c)}${r.r} contains an Excel error (${cellText(cell)})`);
          }
        }
        return { label: cleanLabel(r.a), cells: cols.map((c) => r.text(c)) };
      });
      if (colHeader && headers.length === 1) {
        const sp = spansOf(ws, colHeader);
        prevSpans = sp.some((s) => s[1] > s[0]) ? sp : null;
      }
      sections.push({ id: newId(), type: "grid", title, label_header: "", groups, columns, rows: gridRows });
    }
    for (const s of sections) delete s._heading;
    return { sections, general };
  }

  const colLetter = (c) => String.fromCharCode(64 + c);

  function parseAvionics(ws, sheetName, warnings) {
    const rows = readRows(ws);
    const header = rows.find((r) => r.a.toUpperCase() === "ATA" && r.valueCols.length >= 3);
    if (!header) return null;
    const cols = header.valueCols;
    const out = [];
    for (const r of rows.slice(header.r)) {
      if (!r.a && !r.cells[2]) break;
      for (const c of cols) {
        const cell = r.cells[c];
        if (!cell) continue;
        if (cell.t === "e" || (isStr(cell) && ERROR_VALUES.has(String(cell.v).trim()))) {
          warnings.push(`${sheetName}!${colLetter(c)}${r.r} contains an Excel error (${cellText(cell)})`);
        } else if (c === 2 && cell.t === "n") {
          warnings.push(`${sheetName}!B${r.r}: component name is a number (${cellText(cell)}), probably a broken formula`);
        }
      }
      out.push({ label: r.a, cells: cols.map((c) => r.text(c)) });
    }
    return { id: newId(), type: "grid", title: "Avionics / Technical Attributes", label_header: header.a,
             groups: [], columns: cols.map((c) => header.text(c)), rows: out };
  }

  function coverFromGeneral(g) {
    const type = g["AIRCRAFT TYPE"] || "";
    let model = type;
    const m = type.match(/(\d{2})-\d+\w*\s*\((\d{3})\)/);
    if (m) model = `ATR${m[1]}-${m[2]}`;
    const y = (g["DATE OF MANUFACTURE"] || "").match(/(\d{4})/);
    return { model, msn: g["AIRCRAFT SERIAL NUMBER"] || "", year: y ? y[1] : "" };
  }

  function setLayoutDefaults(sections) {
    for (const s of sections) {
      s.page_break_before = s.page_break_before || false;
      s.hidden = s.hidden || false;
      const t = (s.title || "").toUpperCase();
      if (s.type === "heading" && t === "PROPELLERS") s.page_break_before = true;
      if (s.type === "grid" && (t === "LANDING GEARS" || t === "AVIONICS / TECHNICAL ATTRIBUTES")) s.page_break_before = true;
    }
  }

  /** ArrayBuffer of an .xlsx -> {spec, warnings} */
  function importWorkbook(buffer, filename) {
    const XLSX = root.XLSX;
    const wb = XLSX.read(buffer, { type: "array", cellNF: true, cellDates: false });
    const warnings = [];
    const specName = wb.SheetNames.find((n) => n.toUpperCase().includes("SPEC")) || wb.SheetNames[0];
    const { sections, general } = parseSpecSheet(wb.Sheets[specName], specName, warnings);
    const avName = wb.SheetNames.find((n) => n.toUpperCase().includes("AVIONIC"));
    if (avName) {
      const av = parseAvionics(wb.Sheets[avName], avName, warnings);
      if (av && av.rows.length) sections.push(av);
    }
    setLayoutDefaults(sections);
    if (!Object.keys(general).length) warnings.push("Could not find the general information block (INFORMATION DATE, AIRCRAFT TYPE, ...).");
    return {
      spec: { cover: coverFromGeneral(general), sections, attachments: [],
              source: { filename: filename || "", info_date: general["INFORMATION DATE"] || "" } },
      warnings,
    };
  }

  /** Images placed in the body of the workbook (e.g. the LOPA). Needs JSZip. */
  async function workbookImages(buffer) {
    const JSZip = root.JSZip;
    if (!JSZip) return [];
    const zip = await JSZip.loadAsync(buffer);
    const out = [];
    const parse = (xml) => new DOMParser().parseFromString(xml, "application/xml");
    const drawings = Object.keys(zip.files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    for (const path of drawings) {
      const relsPath = path.replace("drawings/", "drawings/_rels/") + ".rels";
      if (!zip.files[relsPath]) continue;
      const rels = {};
      for (const r of parse(await zip.file(relsPath).async("string")).getElementsByTagName("Relationship")) {
        rels[r.getAttribute("Id")] = r.getAttribute("Target");
      }
      const doc = parse(await zip.file(path).async("string"));
      const anchors = [...doc.getElementsByTagName("*")].filter((e) => /(two|one)CellAnchor$/.test(e.localName));
      for (const a of anchors) {
        const from = [...a.getElementsByTagName("*")].find((e) => e.localName === "from");
        const rowEl = from && [...from.getElementsByTagName("*")].find((e) => e.localName === "row");
        const row = rowEl ? parseInt(rowEl.textContent, 10) : 0;
        const blip = [...a.getElementsByTagName("*")].find((e) => e.localName === "blip");
        if (!blip || row < 5) continue; // row < 5: the logo in the sheet header
        const rid = blip.getAttribute("r:embed") || blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
        const target = rels[rid];
        if (!target) continue;
        const mediaPath = "xl/" + target.replace(/^\.\.\//, "");
        const f = zip.file(mediaPath);
        if (!f) continue;
        const ext = mediaPath.split(".").pop().toLowerCase();
        out.push({ title: "LOPA", ext, data: await f.async("uint8array") });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- diff
  function flatten(spec) {
    const out = {};
    const cover = (spec && spec.cover) || {};
    out["Cover › Model"] = cover.model || ""; out["Cover › MSN"] = cover.msn || ""; out["Cover › Year"] = cover.year || "";
    let heading = "";
    for (const s of (spec && spec.sections) || []) {
      if (s.type === "heading") { heading = s.title || ""; continue; }
      const name = s.title || heading || "Section";
      const seen = {};
      const key = (label) => { seen[label] = (seen[label] || 0) + 1; return seen[label] === 1 ? label : `${label} #${seen[label]}`; };
      if (s.type === "kv") for (const r of s.rows) out[`${name} › ${key(r.label)}`] = r.value;
      else if (s.type === "grid") {
        const groups = [];
        for (const g of s.groups || []) for (let k = 0; k < g.span; k++) groups.push(g.label);
        const av = name.toUpperCase().includes("AVIONIC");
        for (const r of s.rows) {
          const rk = key(av ? `${r.cells[0] || ""} (${r.label})` : r.label);
          r.cells.forEach((c, j) => {
            let col = s.columns[j] !== undefined ? s.columns[j] : `col ${j + 1}`;
            if (groups[j]) col = `${groups[j]} ${col}`;
            out[`${name} › ${rk} › ${col}`] = c;
          });
        }
      } else if (s.type === "list") s.items.forEach((it, i) => (out[`${name} › line ${i + 1}`] = it.text));
    }
    for (const a of (spec && spec.attachments) || []) out[`Extra page › ${a.title || a.asset}`] = a.hidden ? "hidden" : "shown";
    return out;
  }

  function diff(oldSpec, newSpec) {
    const a = flatten(oldSpec || {}), b = flatten(newSpec);
    const changes = [];
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) { if (v) changes.push({ field: k, old: "", new: v }); }
      else if (a[k] !== v) changes.push({ field: k, old: a[k], new: v });
    }
    for (const [k, v] of Object.entries(a)) if (!(k in b) && v) changes.push({ field: k, old: v, new: "" });
    return changes;
  }

  // ---------------------------------------------------------------- JSON-pointer edits
  function applyOps(spec, ops) {
    const doc = JSON.parse(JSON.stringify(spec));
    for (const op of ops || []) {
      if (typeof op.path !== "string" || !op.path.startsWith("/")) throw new Error(`Invalid path ${op.path}`);
      const parts = op.path.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (!["cover", "sections", "attachments"].includes(parts[0])) throw new Error(`Edits outside the sheet are not allowed: ${op.path}`);
      let parent = doc;
      for (const p of parts.slice(0, -1)) {
        parent = Array.isArray(parent) ? parent[+p] : parent[p];
        if (parent === undefined || parent === null) throw new Error(`Nothing at ${op.path}`);
      }
      const key = parts[parts.length - 1];
      const value = op.value_json ? JSON.parse(op.value_json) : op.value;
      if (op.op === "replace") {
        if (Array.isArray(parent)) { if (+key >= parent.length) throw new Error(`Nothing at ${op.path}`); parent[+key] = value; }
        else { if (!(key in parent)) throw new Error(`Nothing at ${op.path}`); parent[key] = value; }
      } else if (op.op === "add") {
        if (Array.isArray(parent)) parent.splice(key === "-" ? parent.length : +key, 0, value);
        else parent[key] = value;
      } else if (op.op === "remove") {
        if (Array.isArray(parent)) parent.splice(+key, 1); else delete parent[key];
      } else throw new Error(`Unknown operation ${op.op}`);
    }
    return doc;
  }

  // ---------------------------------------------------------------- PDF (pdfmake definition)
  const PAGE_W = 540, PAGE_H = 780, NAVY = "#003087", SKY = "#00A9E0", STRIPE = "#F1F3F9", INK = "#1B2233", RULE = "#C9D3E8";

  /**
   * spec, settings, assets = { logoWhite, logoColor, images: {assetId: dataUrl} } -> pdfmake doc definition.
   * Page 1 is the cover; content pages are numbered from 2, like the existing ACIA PDFs.
   */
  function buildPdf(spec, settings, assets) {
    const cover = spec.cover || {};
    const content = [];

    // ---- cover (page 1): text placed absolutely over the background drawing
    content.push({ image: assets.logoWhite, width: 200, absolutePosition: { x: (PAGE_W - 200) / 2, y: 52 } });
    const facts = [["AIRCRAFT MODEL", cover.model], ["AIRCRAFT MSN", cover.msn], ["YEAR OF MANUFACTURE", cover.year]];
    facts.forEach(([k, v], i) => {
      const y = 222 + i * 30;
      content.push({ columns: [{ width: 160, text: k, alignment: "center", color: "#FFFFFF", fontSize: 9.5, characterSpacing: 0.3 }],
                     absolutePosition: { x: 46, y: y + 5.5 } });
      content.push({ columns: [{ width: 280, text: v || "", alignment: "center", color: NAVY, bold: true, fontSize: 10 }],
                     absolutePosition: { x: 214, y: y + 5.5 } });
    });
    const contacts = settings.contacts || [];
    const person = (c, align) => ({ stack: [
      { text: c.name || "", bold: true, color: NAVY, fontSize: 9 },
      { text: c.title || "", color: "#FFFFFF" },
      { text: c.email || "", color: "#FFFFFF", decoration: "underline" },
      { text: c.phone || "", color: "#FFFFFF" }], alignment: align || "center", fontSize: 8.6, lineHeight: 1.12 });
    const contactStack = [{ text: settings.contacts_heading || "", italics: true, bold: true, color: "#FFFFFF", fontSize: 10, alignment: "center", margin: [0, 0, 0, 12] }];
    if (contacts[0]) contactStack.push(person(contacts[0]));
    for (let i = 1; i < contacts.length; i += 2) {
      const row = contacts.slice(i, i + 2).map((c) => ({ ...person(c), width: "*" }));
      contactStack.push({ columns: row, margin: [0, 14, 0, 0] });
    }
    content.push({ columns: [{ width: PAGE_W - 60, stack: contactStack }], absolutePosition: { x: 30, y: 492 } });
    content.push({ columns: [{ width: PAGE_W - 80, text: settings.disclaimer || "", alignment: "center",
                   italics: true, fontSize: 5.2, color: NAVY, lineHeight: 1.15 }], absolutePosition: { x: 40, y: 712 } });
    // Cover texts are absolutely placed; start the body on page 2.
    content.push({ text: "", pageBreak: "after" });

    // ---- body
    let first = true;
    const h2 = (t, brk) => ({ stack: [
      { text: t, fontSize: 12.5, bold: true, color: NAVY, characterSpacing: 0.2 },
      { canvas: [{ type: "line", x1: 0, y1: 2, x2: PAGE_W - 64, y2: 2, lineWidth: 1.2, lineColor: NAVY }] }],
      margin: [0, 4, 0, 6], pageBreak: brk ? "before" : undefined, headlineLevel: 1 });
    const zebra = { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 2.4, paddingBottom: () => 2.4,
                    paddingLeft: () => 4, paddingRight: () => 4 };

    for (const s of spec.sections || []) {
      if (s.hidden) continue;
      const brk = s.page_break_before && !first;
      first = false;
      if (s.type === "heading") { content.push(h2(s.title || "", brk)); continue; }
      if (s.type === "kv") {
        const body = (s.rows || []).map((r) => [{ text: r.label, bold: true }, { text: r.value }]);
        if (!body.length) continue;
        content.push({ stack: [s.title ? h2(s.title.toUpperCase()) : null,
          { table: { widths: ["40%", "*"], body }, layout: { ...zebra, fillColor: (i) => (i % 2 === 0 ? STRIPE : null) } }].filter(Boolean),
          margin: [0, 0, 0, 12], pageBreak: brk ? "before" : undefined, unbreakable: body.length < 25 });
        continue;
      }
      if (s.type === "list") {
        content.push({ stack: [s.title ? { text: s.title.toUpperCase(), bold: true, color: NAVY, fontSize: 9, margin: [0, 0, 0, 4] } : null,
          ...(s.items || []).map((it, i) => ({ text: it.text, bold: !!it.bold, color: it.bold ? NAVY : INK, margin: [0, it.bold && i ? 6 : 0, 0, 2.5] }))].filter(Boolean),
          margin: [0, 0, 0, 12], pageBreak: brk ? "before" : undefined });
        continue;
      }
      if (s.type === "grid") content.push(gridTable(s, brk));
    }
    for (const a of spec.attachments || []) {
      if (a.hidden || !assets.images[a.asset]) continue;
      content.push({ stack: [a.title ? h2(a.title.toUpperCase()) : null,
        { image: assets.images[a.asset], fit: [PAGE_W - 64, PAGE_H - 74 - 46 - 40], alignment: "center", margin: [0, 6, 0, 0] }].filter(Boolean),
        pageBreak: "before" });
    }

    function gridTable(s, brk) {
      const av = (s.title || "").toUpperCase().includes("AVIONIC");
      const n = s.columns.length;
      const headStyle = { bold: true, color: NAVY, alignment: "center" };
      const body = [];
      let headerRows = 1;
      if (s.groups && s.groups.length) {
        const row = [{ text: av ? "" : s.title || "", bold: true, color: NAVY, fontSize: 7.4 }];
        for (const g of s.groups) {
          row.push({ text: g.label, ...headStyle, colSpan: g.span, border: [false, false, false, !!g.label] });
          for (let k = 1; k < g.span; k++) row.push({});
        }
        body.push(row); headerRows = 2;
      }
      const leftHead = av ? s.label_header : (s.groups && s.groups.length ? s.label_header : s.title || s.label_header);
      body.push([{ text: leftHead || "", bold: true, color: NAVY, alignment: av ? "center" : "left" },
                 ...s.columns.map((c) => ({ text: c, ...headStyle, alignment: av ? "left" : "center" }))]);
      for (const r of s.rows) {
        const cells = r.cells.slice(0, n);
        while (cells.length < n) cells.push("");
        body.push([{ text: r.label, bold: !av, alignment: av ? "center" : "left" },
                   ...cells.map((c) => ({ text: c, alignment: av ? "left" : "center" }))]);
      }
      const labelW = av ? 26 : n >= 5 ? 128 : 150;
      const widths = [labelW, ...s.columns.map(() => "*")];
      if (av && n === 6) widths.splice(1, 6, "*", 62, 56, "*", 46, 32);
      const table = {
        table: { headerRows, widths, body, dontBreakRows: true },
        fontSize: av ? 6.5 : n >= 5 ? 7 : 7.4,
        layout: {
          hLineWidth: (i) => (i === headerRows ? 0.9 : headerRows === 2 && i === 1 ? 0.5 : 0),
          hLineColor: (i) => (i === headerRows ? NAVY : RULE),
          vLineWidth: () => 0,
          fillColor: (i) => (i >= headerRows && (i - headerRows) % 2 === 0 ? STRIPE : null),
          paddingTop: () => 2.4, paddingBottom: () => 2.4,
          paddingLeft: () => (n >= 5 ? 2.6 : 4), paddingRight: () => (n >= 5 ? 2.6 : 4),
        },
      };
      return { stack: [av ? h2((s.title || "").toUpperCase()) : null, table].filter(Boolean),
               margin: [0, 0, 0, 13], pageBreak: brk ? "before" : undefined, unbreakable: s.rows.length <= 18 };
    }

    return {
      pageSize: { width: PAGE_W, height: PAGE_H },
      pageMargins: [32, 74, 32, 46],
      info: { title: `MSN ${cover.msn || ""} ${cover.model || ""} - ${settings.doc_title || ""}`, author: settings.company || "" },
      defaultStyle: { font: assets.fontName || "Inter", fontSize: 7.4, color: INK, lineHeight: 1.1 },
      background: (page) => page === 1 ? { canvas: [
          { type: "rect", x: 0, y: 0, w: PAGE_W, h: PAGE_H, color: SKY },
          { type: "polyline", closePath: true, points: [{ x: 0, y: 0 }, { x: PAGE_W, y: 0 }, { x: PAGE_W, y: PAGE_H * 0.58 }, { x: 0, y: PAGE_H * 0.625 }], color: NAVY },
          ...[0, 1, 2].flatMap((i) => {
            const y = 222 + i * 30, sk = 5;
            return [
              { type: "polyline", closePath: true, points: [{ x: 46 + sk, y }, { x: 206 + sk, y }, { x: 206 - sk, y: y + 20 }, { x: 46 - sk, y: y + 20 }], color: SKY },
              { type: "polyline", closePath: true, points: [{ x: 214 + sk, y }, { x: 494 + sk, y }, { x: 494 - sk, y: y + 20 }, { x: 214 - sk, y: y + 20 }], color: "#FFFFFF" },
            ];
          })] }
        : { canvas: [
          { type: "line", x1: 32, y1: 58, x2: PAGE_W - 32, y2: 58, lineWidth: 0.75, lineColor: SKY },
          { type: "polyline", closePath: true, points: [{ x: 0, y: PAGE_H - 26 }, { x: PAGE_W * 0.83, y: PAGE_H - 26 }, { x: PAGE_W * 0.86, y: PAGE_H }, { x: 0, y: PAGE_H }], color: NAVY }] },
      header: (page) => page === 1 ? null : {
        margin: [32, 24, 32, 0],
        columns: [
          { width: "*", stack: [
            { text: settings.confidential || "", fontSize: 5.6, characterSpacing: 0.2, color: INK },
            { text: [{ text: settings.company || "", bold: true }, ` – ${settings.doc_title || ""}`], fontSize: 9.5, color: NAVY, margin: [0, 2, 0, 0] }] },
          { width: 92, image: assets.logoColor, fit: [92, 22], margin: [0, -1, 0, 0] }],
      },
      footer: (page) => page === 1 ? null : {
        margin: [32, 28.5, 32, 0],
        columns: [
          { width: "*", text: [{ text: settings.company || "", bold: true }, ` | MSN ${cover.msn || ""}`], color: "#FFFFFF", fontSize: 7.2 },
          { width: 40, text: String(page), alignment: "right", color: NAVY, bold: true, fontSize: 7.2 }],
      },
      pageBreakBefore: (node, after) => node.headlineLevel === 1 && after.length === 0,
      content,
    };
  }

  root.SpecCore = { importWorkbook, workbookImages, diff, applyOps, buildPdf, formatNumber, newId, setLayoutDefaults };
})(typeof window !== "undefined" ? window : globalThis);
