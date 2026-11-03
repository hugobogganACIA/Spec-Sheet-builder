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
  const PAGE_W = 540, PAGE_H = 780, NAVY = "#003087", SKY = "#00A9E0", STRIPE = "#F1F3F9", INK = "#011135", RULE = "#C9D3E8";

  /**
   * spec, settings, assets = { logoWhite, logoColor, images: {assetId: dataUrl} } -> pdfmake doc definition.
   * Page 1 is the cover; content pages are numbered from 2, like the existing ACIA PDFs.
   */
  function buildPdf(spec, settings, assets) {
    const cover = spec.cover || {};
    const content = [];

    // ---- cover (page 1): navy masthead with the model, the aircraft type's illustration
    // on white, a facts strip, then contacts and disclaimer on a navy footer band.
    const kvFind = (label, underHeading) => {
      let hd = "";
      for (const s of spec.sections || []) {
        if (s.type === "heading") { hd = (s.title || "").toUpperCase(); continue; }
        if (s.type !== "kv" || (underHeading && hd !== underHeading)) continue;
        for (const r of s.rows) if ((r.label || "").toUpperCase() === label) return r.value || "";
      }
      return "";
    };
    const white = "#FFFFFF", paleSky = "#9FDDF4";
    const at = (x, y, width, node) => content.push({ columns: [{ width, ...node }], absolutePosition: { x, y } });

    content.push({ image: assets.logoWhite, width: 132, absolutePosition: { x: 36, y: 34 } });
    at(PAGE_W - 236, 38, 200, { text: (settings.doc_title || "").toUpperCase(), alignment: "right", color: white, font: "Heading", fontSize: 7.5, characterSpacing: 1 });
    const infoDate = kvFind("INFORMATION DATE");
    if (infoDate) at(PAGE_W - 236, 50, 200, { text: `Status as of ${infoDate}`, alignment: "right", color: paleSky, fontSize: 7.5 });

    const isEngine = cover.kind === "engine";
    const idLabel = isEngine ? "ESN" : "MSN";
    at(36, 112, 470, { text: isEngine ? "ENGINE MODEL" : "AIRCRAFT MODEL", color: paleSky, font: "Heading", fontSize: 8, characterSpacing: 1.6 });
    at(36, 126, 470, { text: cover.model || "", color: white, font: "Feature", fontSize: 38, lineHeight: 1 });
    at(36, 178, 470, { text: [{ text: idLabel + " ", color: paleSky }, { text: cover.msn || "", color: white }], font: "Heading", fontSize: 18 });

    // Illustration: sits on a ground line, centred, scaled to the type's proportions.
    // Aircraft sheets show the aircraft type; engine sheets show the engine type (larger, it is the subject).
    const art = isEngine ? assets.engine : assets.aircraft;
    const groundY = isEngine ? 458 : 452;
    if (art && art.src) {
      const maxW = isEngine ? 340 : 476, maxH = isEngine ? 196 : 168;
      const w = Math.min(maxW, maxH * art.ratio), hgt = w / art.ratio;
      content.push({ image: art.src, width: w, absolutePosition: { x: (PAGE_W - w) / 2, y: groundY - hgt } });
    }

    const kvLike = (re) => {
      for (const s of spec.sections || []) if (s.type === "kv") for (const r of s.rows) if (re.test(r.label || "")) return r.value || "";
      return "";
    };
    const facts = isEngine ? [
      ["ESN", cover.msn],
      ["TSN", kvLike(/\bTSN\b|TIME SINCE NEW/i)],
      ["CSN", kvLike(/\bCSN\b|CYCLES SINCE NEW/i)],
    ] : [
      ["MSN", cover.msn],
      ["YEAR BUILT", cover.year],
      ["REGISTRATION", kvFind("AIRCRAFT REGISTRATION")],
      kvFind("MODEL", "ENGINES") ? ["ENGINES", kvFind("MODEL", "ENGINES")] : ["CONFIGURATION", kvFind("AIRCRAFT CONFIGURATION")],
    ];
    const colW = (PAGE_W - 72) / facts.length;
    facts.forEach(([k, v], i) => {
      at(36 + i * colW + (i ? 12 : 0), 486, colW - 14, { stack: [
        { text: k, color: SKY, font: "Heading", fontSize: 6.8, characterSpacing: 1.1 },
        { text: v || "–", color: NAVY, font: "Heading", fontSize: 13, margin: [0, 4, 0, 0] }] });
    });

    const contacts = (settings.contacts || []).filter((c) => c && (c.name || c.email));
    at(36, 588, PAGE_W - 72, { text: settings.contacts_heading || "", color: paleSky, font: "Heading", fontSize: 8, characterSpacing: 1 });
    const perRow = Math.min(3, Math.max(1, contacts.length));
    for (let i = 0; i < contacts.length; i += perRow) {
      const row = contacts.slice(i, i + perRow).map((c) => ({ width: "*", stack: [
        { text: c.name || "", color: white, font: "Heading", fontSize: 10 },
        c.title ? { text: c.title, color: paleSky, fontSize: 7.6, margin: [0, 1, 0, 3] } : { text: "", margin: [0, 0, 0, 3] },
        c.email ? { text: c.email, color: white, fontSize: 7.4 } : null,
        c.phone ? { text: c.phone, color: white, fontSize: 7.4 } : null].filter(Boolean) }));
      while (row.length < perRow) row.push({ width: "*", text: "" });
      at(36, 606 + (i / perRow) * 54, PAGE_W - 72, { columns: row, columnGap: 14 });
    }
    at(36, 690, PAGE_W - 72, { text: settings.disclaimer || "", color: paleSky, fontSize: 4.9, lineHeight: 1.12, alignment: "justify" });
    // Cover texts are absolutely placed; start the body on page 2.
    content.push({ text: "", pageBreak: "after" });

    // ---- body
    let first = true;
    const h2 = (t, brk) => ({ stack: [
      { text: t, font: "Heading", fontSize: 12.5, color: NAVY },
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
        const table = { table: { widths: ["40%", "*"], body }, layout: { ...zebra, fillColor: (i) => (i % 2 === 0 ? STRIPE : null) } };
        content.push({ stack: [s.title ? h2(s.title.toUpperCase()) : null, table].filter(Boolean),
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
      defaultStyle: { font: assets.fontName || "Archivo", fontSize: 7.4, color: INK, lineHeight: 1.1 },
      background: (page) => page === 1 ? { canvas: [
          // masthead with a livery-style diagonal and sky stripe
          { type: "polyline", closePath: true, points: [{ x: 0, y: 0 }, { x: PAGE_W, y: 0 }, { x: PAGE_W, y: 196 }, { x: 0, y: 252 }], color: SKY },
          { type: "polyline", closePath: true, points: [{ x: 0, y: 0 }, { x: PAGE_W, y: 0 }, { x: PAGE_W, y: 188 }, { x: 0, y: 244 }], color: NAVY },
          // facts strip rules
          { type: "line", x1: 36, y1: 474, x2: PAGE_W - 36, y2: 474, lineWidth: 0.8, lineColor: NAVY },
          ...facts.slice(1).map((_, j) => { const x = 36 + (j + 1) * (PAGE_W - 72) / facts.length; return { type: "line", x1: x, y1: 486, x2: x, y2: 520, lineWidth: 0.5, lineColor: RULE }; }),
          // contacts band
          { type: "polyline", closePath: true, points: [{ x: 0, y: 560 }, { x: PAGE_W, y: 548 }, { x: PAGE_W, y: PAGE_H }, { x: 0, y: PAGE_H }], color: NAVY },
          { type: "polyline", closePath: true, points: [{ x: 0, y: 556 }, { x: PAGE_W, y: 544 }, { x: PAGE_W, y: 548 }, { x: 0, y: 560 }], color: SKY }] }
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
          { width: "*", text: [{ text: settings.company || "", bold: true }, ` | ${cover.kind === "engine" ? "ESN" : "MSN"} ${cover.msn || ""}`], color: "#FFFFFF", fontSize: 7.2 },
          { width: 40, text: String(page), alignment: "right", color: NAVY, bold: true, fontSize: 7.2 }],
      },
      pageBreakBefore: (node, after) => node.headlineLevel === 1 && after.length === 0,
      content,
    };
  }

  /** Which illustration fits this aircraft: cover.illustration overrides ("none" hides it), else detected from model/type. */
  function aircraftKey(spec) {
    const c = (spec && spec.cover) || {};
    if (c.illustration && c.illustration !== "auto") return c.illustration === "none" ? null : c.illustration;
    let type = "";
    for (const s of (spec && spec.sections) || []) if (s.type === "kv") for (const r of s.rows) if ((r.label || "").toUpperCase() === "AIRCRAFT TYPE") type = r.value || "";
    const match = (t) => {
      t = t.toUpperCase();
      if (/ATR\s*-?\s*72|\b72-[12]\d\d/.test(t)) return "atr72";
      if (/ATR\s*-?\s*42|\b42-[35]\d\d/.test(t)) return "atr42";
      if (/DHC\s*-?\s*6|TWIN\s*OTTER/.test(t)) return "dhc6";
      if (/1900|BEECH|B190/.test(t)) return "b1900";
      if (/ERJ|EMB\s*-?\s*1[34][05]|\bE1[34]5/.test(t)) return "erj145";
      if (/A\s*-?\s*320|\b320-[12]\d\d/.test(t)) return "a320";
      return null;
    };
    return match(c.model || "") || match(type); // the cover model wins over the sheet's type code
  }
  const AIRCRAFT_TYPES = [["atr72", "ATR 72"], ["atr42", "ATR 42"], ["dhc6", "DHC-6 Twin Otter"], ["b1900", "Beechcraft 1900"], ["erj145", "Embraer ERJ 145"], ["a320", "Airbus A320"]];

  /** Engine illustration for an engine spec sheet's cover: cover.engine_illustration overrides ("none" hides it), else detected from the model. */
  function engineKey(spec) {
    const c = (spec && spec.cover) || {};
    if (c.engine_illustration && c.engine_illustration !== "auto") return c.engine_illustration === "none" ? null : c.engine_illustration;
    const kv = [], grid = [];
    let hd = "";
    for (const s of (spec && spec.sections) || []) {
      if (s.type === "heading") { hd = (s.title || "").toUpperCase(); continue; }
      if (hd !== "ENGINES") continue;
      if (s.type === "kv") for (const r of s.rows) kv.push(r.value || "");
      if (s.type === "grid") for (const r of s.rows) if (/TYPE|MODEL/i.test(r.label || "")) grid.push(...r.cells);
    }
    const match = (t) => {
      t = t.toUpperCase();
      if (/PW\s*-?\s*127/.test(t)) return "pw127";
      if (/PT\s*-?\s*6/.test(t)) return "pt6";
      if (/V\s*-?\s*25\d\d/.test(t)) return "v2500";
      return null;
    };
    return match(c.model || "") || match(kv.join(" ")) || match(grid.join(" ")); // cover model, then ENGINES fields, then tables
  }
  const ENGINE_TYPES = [["pw127", "Pratt & Whitney PW127"], ["pt6", "Pratt & Whitney PT6"], ["v2500", "IAE V2500"]];

  root.SpecCore = { cellText, aircraftKey, AIRCRAFT_TYPES, engineKey, ENGINE_TYPES, importWorkbook, workbookImages, diff, applyOps, buildPdf, formatNumber, newId, setLayoutDefaults };
})(typeof window !== "undefined" ? window : globalThis);
