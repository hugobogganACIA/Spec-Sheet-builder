/* ===== Normalise any tech-spec workbook into ONE standard data shape, then ONE standard layout =====
   Known ACIA template  -> deterministic parse (SpecCore.importWorkbook) -> templateToData()
   Any other layout     -> workbookDump() -> Claude fills STANDARD_SCHEMA -> verifyAgainstWorkbook()
   Either way           -> standardSpec(data) builds the same sections in the same order. */
(function (root) {
  "use strict";
  const C = root.SpecCore;
  const up = (s) => String(s || "").toUpperCase();

  // ---------------------------------------------------------------- field sets (key, printed label, how to recognise it)
  const GENERAL = [
    ["info_date", "INFORMATION DATE", /INFORMATION DATE|STATUS DATE|SITUATION DATE|AS OF|DATE OF REPORT/],
    ["type", "AIRCRAFT TYPE", /AIRCRAFT TYPE|A\/C TYPE|AIRCRAFT MODEL|^TYPE$/],
    ["config", "AIRCRAFT CONFIGURATION", /CONFIGURATION/],
    ["dom", "DATE OF MANUFACTURE", /DATE OF MANUFACTURE|MANUFACTURE DATE|DOM/],
    ["age", "A/C AGE (YRS)", /AGE/],
    ["tt", "AIRFRAME TOTAL TIME", /TOTAL TIME|AIRFRAME.*(TSN|HOURS|FH)|TOTAL HOURS/],
    ["tc", "AIRFRAME TOTAL CYCLES", /TOTAL CYCLES|AIRFRAME.*(CSN|CYCLES|FC)/],
    ["reg", "AIRCRAFT REGISTRATION", /REGISTRATION|REG\b/],
    ["msn", "AIRCRAFT SERIAL NUMBER", /SERIAL NUMBER|MSN/],
  ];
  const ENGINE_UNIT = [
    ["type", "MANUFACTURER TYPE", /TYPE|MODEL/],
    ["esn", "MANUFACTURER SERIAL NUMBER", /SERIAL|ESN/],
    ["tsn", "TIME SINCE NEW (TSN)", /TSN|TIME SINCE NEW/],
    ["csn", "CYCLES SINCE NEW (CSN)", /CSN|CYCLES SINCE NEW/],
  ];
  const MODULE = [
    ["sn", "MANUFACTURER SERIAL NUMBER", /SERIAL/],
    ["tso", "TIME SINCE OVERHAUL (TSO)", /TSO|TIME SINCE OVERHAUL/],
    ["cso", "CYCLES SINCE OVERHAUL (CSO)", /CSO|CYCLES SINCE OVERHAUL/],
    ["tshsi", "TIME SINCE HOT SECTION (TSHSI)", /HOT SECTION|TSHSI/],
  ];
  const PROP_PART = [
    ["sn", "MANUFACTURER SERIAL NUMBER", /SERIAL/],
    ["tsn", "TIME SINCE NEW (TSN)", /TSN|TIME SINCE NEW/],
    ["tso", "TIME SINCE OVERHAUL (TSO)", /TSO|TIME SINCE OVERHAUL/],
    ["install", "INSTALLATION / LAST OVH DATE", /INSTALL|LAST OVH|LAST OVERHAUL/],
    ["cal", "CALENDAR CONSUMED", /CALENDAR/],
    ["next", "NEXT OVERHAUL DATE", /NEXT/],
    ["limit_fh", "OVERHAUL LIMIT (FHRS)", /LIMIT.*(FH|HRS)/],
    ["rem_fh", "TIME REMAINING TO OVERHAUL (FHRS)", /REMAINING.*(FH|HRS)|REMAINING TO OV/],
    ["limit_m", "OVERHAUL LIMIT (MNTHS)", /LIMIT.*(MNTH|MONTH)/],
    ["rem_m", "REMAINING MONTHS", /REMAINING.*(MNTH|MONTH)/],
  ];
  const GEAR = [
    ["sn", "MANUFACTURER SERIAL NUMBER", /SERIAL/],
    ["csn", "CYCLES SINCE NEW (CSN)", /CSN|CYCLES SINCE NEW/],
    ["cso", "CYCLES SINCE OVERHAUL (CSO)", /CSO|CYCLES SINCE OVERHAUL/],
    ["install", "INSTALLATION / LAST OVERHAUL DATE", /INSTALL|LAST OVH|LAST OVERHAUL/],
    ["cal", "CALENDAR CONSUMED", /CALENDAR/],
    ["limit_m", "OVERHAUL LIMIT (MNTHS)", /LIMIT/],
    ["rem_m", "REMAINING MONTHS", /REMAINING/],
  ];
  const WEIGHTS = [
    ["MAXIMUM TAKE-OFF WEIGHT (MTOW)", /TAKE.?OFF|MTOW/],
    ["MAXIMUM LANDING WEIGHT (MLW)", /LANDING WEIGHT|MLW/],
    ["MAXIMUM ZERO FUEL WEIGHT (MZFW)", /ZERO FUEL|MZFW/],
    ["MAXIMUM FUEL", /MAXIMUM FUEL|FUEL CAPACITY/],
    ["DATE OF LAST WEIGHING", /WEIGHING/],
  ];
  // Standalone engine spec sheets
  const ENGINE_GENERAL = [
    ["info_date", "INFORMATION DATE"], ["manufacturer", "ENGINE MANUFACTURER"], ["model", "ENGINE MODEL"], ["esn", "ENGINE SERIAL NUMBER"],
    ["thrust", "THRUST / POWER RATING"], ["dom", "DATE OF MANUFACTURE"], ["tsn", "TIME SINCE NEW (TSN)"], ["csn", "CYCLES SINCE NEW (CSN)"],
    ["tslsv", "TIME SINCE LAST SHOP VISIT (TSLSV)"], ["cslsv", "CYCLES SINCE LAST SHOP VISIT (CSLSV)"], ["last_sv_date", "LAST SHOP VISIT DATE"],
    ["last_sv_mro", "LAST SHOP VISIT MRO"], ["last_sv_workscope", "LAST SHOP VISIT WORKSCOPE"], ["status", "CONDITION / STATUS"], ["location", "LOCATION"],
  ];
  const fieldFor = (set, label) => { const l = up(label); const f = set.find(([, , re]) => re.test(l)); return f ? f[0] : null; };

  // ---------------------------------------------------------------- deterministic template -> data
  function templateToData(spec) {
    const d = emptyData();
    let heading = "";
    const gridsUnder = {};
    for (const s of spec.sections || []) {
      if (s.type === "heading") { heading = up(s.title); continue; }
      (gridsUnder[heading] = gridsUnder[heading] || []).push(s);
    }
    const top = gridsUnder[""] || [];
    // general
    for (const s of top.filter((x) => x.type === "kv")) for (const r of s.rows) {
      const k = fieldFor(GENERAL, r.label);
      if (k && !d.general[k]) d.general[k] = r.value; else d.general_extra.push({ label: r.label, value: r.value });
    }
    // engines
    const eng = gridsUnder.ENGINES || [];
    for (const s of eng.filter((x) => x.type === "kv")) for (const r of s.rows) {
      if (/MANUFACTURER/.test(up(r.label))) d.engines.manufacturer = r.value;
      else if (/MODEL|TYPE/.test(up(r.label))) d.engines.model = r.value;
    }
    const egrids = eng.filter((x) => x.type === "grid");
    const unitsGrid = egrids.find((g) => !g.groups.length && g.rows.some((r) => fieldFor(ENGINE_UNIT, r.label) === "tsn"));
    if (unitsGrid) d.engines.units = unitsGrid.columns.map((pos, i) => {
      const u = { position: pos };
      for (const r of unitsGrid.rows) { const k = fieldFor(ENGINE_UNIT, r.label); if (k) u[k] = r.cells[i] || ""; }
      return u;
    });
    const modGrid = egrids.find((g) => g !== unitsGrid && g.rows.some((r) => fieldFor(MODULE, r.label) === "tso"));
    if (modGrid) {
      const groupOf = expandGroups(modGrid);
      modGrid.columns.forEach((name, i) => {
        const m = { unit: groupOf[i] || "", name };
        for (const r of modGrid.rows) { const k = fieldFor(MODULE, r.label); if (k) m[k] = r.cells[i] || ""; }
        d.engines.modules.push(m);
      });
    }
    const llpGrid = egrids.find((g) => /LIFE|LLP|ROTABLE/.test(up(g.title)));
    if (llpGrid) {
      const groupOf = expandGroups(llpGrid);
      const units = [...new Set(groupOf)];
      d.engines.llp_units = units;
      for (const r of llpGrid.rows) {
        const vals = units.map((u) => {
          const idx = groupOf.map((g, i) => (g === u ? i : -1)).filter((i) => i >= 0);
          const pick = (re) => { const i = idx.find((j) => re.test(up(llpGrid.columns[j]))); return i === undefined ? "" : r.cells[i] || ""; };
          return { limit: pick(/LIMIT/), csn: pick(/CSN|TSN|USED/), remaining: pick(/REMAIN/) };
        });
        d.engines.llps.push({ part: r.label, units: vals });
      }
    }
    // propellers
    const prop = gridsUnder.PROPELLERS || [];
    for (const s of prop.filter((x) => x.type === "kv")) for (const r of s.rows) {
      if (/MANUFACTURER/.test(up(r.label))) d.propellers.manufacturer = r.value;
      else if (/TYPE|MODEL/.test(up(r.label))) d.propellers.type = r.value;
    }
    for (const g of prop.filter((x) => x.type === "grid")) {
      if (/BLADE/.test(up(g.title)) || g.columns.every((c) => /BLADE/.test(up(c)))) {
        const pos = up(g.title).replace(/PROP.*$/, "").trim() || `PROP ${d.propellers.blades.length + 1}`;
        d.propellers.blades.push({ position: pos, blades: g.columns.map((_, i) => rowObj(g, i, PROP_PART)) });
      } else if (/LANDING|GEAR/.test(up(g.title))) {
        d.landing_gears = g.columns.map((pos, i) => ({ position: pos, ...rowObj(g, i, GEAR) }));
      } else if (/INSPECTION|CHECK/.test(up(g.title))) {
        d.inspections = inspectionsFrom(g);
      } else {
        const groupOf = expandGroups(g);
        g.columns.forEach((name, i) => {
          const pos = groupOf[i] || "PROP";
          let u = d.propellers.units.find((x) => x.position === pos);
          if (!u) d.propellers.units.push((u = { position: pos, parts: [] }));
          u.parts.push({ name, ...rowObj(g, i, PROP_PART) });
        });
      }
    }
    // the remaining tables can sit under any heading in the template
    for (const g of Object.values(gridsUnder).flat().filter((x) => x.type === "grid")) {
      const t = up(g.title);
      if (/LANDING GEAR/.test(t) && !d.landing_gears.length) d.landing_gears = g.columns.map((pos, i) => ({ position: pos, ...rowObj(g, i, GEAR) }));
      if (/INSPECTION/.test(t) && !d.inspections.length) d.inspections = inspectionsFrom(g);
      if (/AVIONIC/.test(t)) d.avionics = g.rows.map((r) => { const c = r.cells; return { ata: r.label, component: c[0] || "", pn: c[1] || "", sn: c[2] || "", manufacturer: c[3] || "", type: c[4] || "", fin: c[5] || "" }; });
    }
    for (const s of gridsUnder.WEIGHTS || []) if (s.type === "kv") for (const r of s.rows) d.weights.push({ label: r.label, value: r.value });
    for (const s of Object.values(gridsUnder).flat()) if (s.type === "list") d.options.push(...s.items.map((i) => ({ text: i.text, bold: !!i.bold })));
    return d;
  }
  function expandGroups(g) { const out = []; for (const gr of g.groups || []) for (let k = 0; k < gr.span; k++) out.push(gr.label); return out; }
  function rowObj(g, i, set) { const o = {}; for (const r of g.rows) { const k = fieldFor(set, r.label); if (k && o[k] === undefined) o[k] = r.cells[i] || ""; } return o; }
  function inspectionsFrom(g) {
    const col = (re) => g.columns.findIndex((c) => re.test(up(c)));
    const ix = { last: col(/LAST/), next: col(/NEXT/), interval: col(/INTERVAL/), remaining: col(/REMAIN/), uom: col(/UOM|UNIT/) };
    return g.rows.map((r) => ({ name: r.label, last: r.cells[ix.last] || "", next: r.cells[ix.next] || "", interval: r.cells[ix.interval] || "",
                                 remaining: r.cells[ix.remaining] || "", uom: r.cells[ix.uom] || "" }));
  }

  function emptyData() {
    return { general: {}, general_extra: [], engines: { manufacturer: "", model: "", units: [], modules: [], llp_units: [], llps: [] },
             propellers: { manufacturer: "", type: "", units: [], blades: [] }, landing_gears: [], inspections: [], weights: [], options: [], avionics: [], notes: [] };
  }

  /** 0..1: how much of the standard sheet the data fills. Used to decide whether a template parse worked. */
  function coverage(d) {
    const g = GENERAL.filter(([k]) => d.general[k]).length / GENERAL.length;
    const e = d.engines.units.length ? 1 : 0;
    return 0.6 * g + 0.4 * e;
  }

  // ---------------------------------------------------------------- data -> the standard layout
  function standardSpec(d, filename) {
    const S = [];
    const id = C.newId;
    const has = (o) => o && Object.values(o).some((v) => v !== "" && v !== undefined && v !== null);
    const grid = (title, columns, rows, groups) => ({ id: id(), type: "grid", title, label_header: "", groups: groups || [], columns, rows });
    const kv = (title, rows) => ({ id: id(), type: "kv", title, rows });
    const groupsOf = (labels) => { const out = []; for (const l of labels) { const last = out[out.length - 1]; if (last && last.label === l) last.span++; else out.push({ label: l, span: 1 }); } return out; };

    S.push(kv("General Description", [...GENERAL.map(([k, label]) => ({ label, value: d.general[k] || "" })), ...(d.general_extra || [])]));

    const E = d.engines || {};
    S.push({ id: id(), type: "heading", title: "ENGINES" });
    S.push(kv("", [{ label: "MANUFACTURER", value: E.manufacturer || "" }, { label: "MODEL", value: E.model || "" }]));
    const units = E.units || [];
    if (units.length) S.push(grid("", units.map((u) => u.position), ENGINE_UNIT.map(([k, label]) => ({ label, cells: units.map((u) => u[k] || "") }))));
    const mods = (E.modules || []).filter(has);
    if (mods.length) S.push(grid("", mods.map((m) => m.name), MODULE.map(([k, label]) => ({ label, cells: mods.map((m) => m[k] || "") })), groupsOf(mods.map((m) => m.unit || ""))));
    const llps = E.llps || [];
    if (llps.length) {
      const lu = E.llp_units && E.llp_units.length ? E.llp_units : units.map((u) => `${u.position}${u.esn ? " " + u.esn : ""}`);
      S.push(grid("ENGINE ROTABLE - LIFE LIMITS", lu.flatMap(() => ["Limit", "CSN", "Remaining"]),
        llps.map((p) => ({ label: p.part, cells: lu.flatMap((_, i) => { const v = (p.units || [])[i] || {}; return [v.limit || "", v.csn || "", v.remaining || ""]; }) })),
        lu.map((l) => ({ label: l, span: 3 }))));
    }

    const P = d.propellers || {};
    const pparts = (P.units || []).flatMap((u) => (u.parts || []).map((p) => ({ ...p, unit: u.position })));
    if (P.manufacturer || pparts.length || (P.blades || []).length) {
      S.push({ id: id(), type: "heading", title: "PROPELLERS" });
      S.push(kv("", [{ label: "MANUFACTURER", value: P.manufacturer || "" }, { label: "TYPE", value: P.type || "" }]));
      if (pparts.length) S.push(grid("", pparts.map((p) => p.name), PROP_PART.map(([k, label]) => ({ label, cells: pparts.map((p) => p[k] || "") })), groupsOf(pparts.map((p) => p.unit))));
      for (const b of P.blades || []) {
        const bl = b.blades || [];
        if (!bl.length) continue;
        S.push(grid(`${up(b.position)} PROP BLADE INFORMATION`, bl.map((_, i) => `BLADE ${i + 1}`), PROP_PART.map(([k, label]) => ({ label, cells: bl.map((x) => x[k] || "") }))));
      }
    }

    const G = d.landing_gears || [];
    if (G.length) S.push(grid("LANDING GEARS", G.map((g) => g.position), GEAR.map(([k, label]) => ({ label, cells: G.map((g) => g[k] || "") }))));
    const I = d.inspections || [];
    if (I.length) S.push(grid("SCHEDULED INSPECTIONS", ["LAST ACTUAL INSP", "NEXT INSPECTION", "INTERVAL", "REMAINING", "UOM"],
      I.map((x) => ({ label: x.name, cells: [x.last || "", x.next || "", x.interval || "", x.remaining || "", x.uom || ""] }))));

    const W = d.weights || [];
    if (W.length) {
      S.push({ id: id(), type: "heading", title: "WEIGHTS" });
      const rows = WEIGHTS.map(([label, re]) => { const w = W.find((x) => re.test(up(x.label))); return w ? { label, value: w.value } : null; }).filter(Boolean);
      for (const w of W) if (!WEIGHTS.some(([, re]) => re.test(up(w.label)))) rows.push({ label: up(w.label), value: w.value });
      S.push(kv("", rows));
    }
    const O = d.options || [];
    if (O.length) { S.push({ id: id(), type: "heading", title: "MAIN OPTIONS" }); S.push({ id: id(), type: "list", title: "", items: O.map((o) => ({ text: o.text, bold: !!o.bold })) }); }
    const A = d.avionics || [];
    if (A.length) S.push({ id: id(), type: "grid", title: "Avionics / Technical Attributes", label_header: "ATA", groups: [],
      columns: ["Components", "P/N", "S/N", "Manufacturer", "Type", "FIN"],
      rows: A.map((a) => ({ label: a.ata || "", cells: [a.component || "", a.pn || "", a.sn || "", a.manufacturer || "", a.type || "", a.fin || ""] })) });

    C.setLayoutDefaults(S);
    const general = Object.fromEntries(GENERAL.map(([k, label]) => [label, d.general[k] || ""]));
    const typeText = general["AIRCRAFT TYPE"];
    let model = typeText;
    const m = typeText.match(/(\d{2})-\d+\w*\s*\((\d{3})\)/);
    if (m) model = `ATR${m[1]}-${m[2]}`;
    const y = (general["DATE OF MANUFACTURE"] || "").match(/(\d{4})/);
    return { cover: { model, msn: general["AIRCRAFT SERIAL NUMBER"], year: y ? y[1] : "" }, sections: S, attachments: [],
             source: { filename: filename || "", info_date: general["INFORMATION DATE"] } };
  }

  // ---------------------------------------------------------------- engine data -> the standard engine layout
  function emptyEngineData() { return { general: {}, general_extra: [], modules: [], llps: [], shop_visits: [], options: [], notes: [] }; }

  function standardEngineSpec(d, filename) {
    const id = C.newId;
    const S = [];
    const grid = (title, label_header, columns, rows, brk) => ({ id: id(), type: "grid", title, label_header, groups: [], columns, rows, page_break_before: !!brk, hidden: false });
    S.push({ id: id(), type: "kv", title: "General Description", page_break_before: false, hidden: false,
             rows: [...ENGINE_GENERAL.map(([k, label]) => ({ label, value: d.general[k] || "" })), ...(d.general_extra || [])] });
    if (d.llps.length) S.push(grid("LIFE LIMITED PARTS", "", ["Module", "Part No.", "Serial No.", "Limit", "CSN", "Remaining"],
      d.llps.map((p) => ({ label: p.part, cells: [p.module, p.pn, p.sn, p.limit, p.csn, p.remaining] }))));
    if (d.modules.length) S.push(grid("MODULES", "", ["Serial No.", "TSN", "CSN", "TSO", "CSO"],
      d.modules.map((m) => ({ label: m.name, cells: [m.sn, m.tsn, m.csn, m.tso, m.cso] }))));
    if (d.shop_visits.length) S.push(grid("SHOP VISIT HISTORY", "DATE", ["MRO", "TSN", "CSN", "Workscope", "Reason"],
      d.shop_visits.map((v) => ({ label: v.date, cells: [v.mro, v.tsn, v.csn, v.workscope, v.reason] }))));
    if (d.options.length) { S.push({ id: id(), type: "heading", title: "NOTES", page_break_before: false, hidden: false });
      S.push({ id: id(), type: "list", title: "", items: d.options, page_break_before: false, hidden: false }); }
    return { cover: { kind: "engine", model: d.general.model || "", msn: d.general.esn || "", year: "" }, sections: S, attachments: [],
             source: { filename: filename || "", info_date: d.general.info_date || "" } };
  }

  // ---------------------------------------------------------------- any layout: dump the workbook as text for Claude
  function workbookDump(buffer, maxChars) {
    const XLSX = root.XLSX;
    const wb = XLSX.read(buffer, { type: "array", cellNF: true, cellDates: false });
    const cells = [];
    let out = "";
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws["!ref"]) continue;
      const range = XLSX.utils.decode_range(ws["!ref"]);
      let block = `\n### Sheet: ${name}\n`;
      for (let r = range.s.r; r <= Math.min(range.e.r, 2000); r++) {
        const parts = [];
        for (let c = range.s.c; c <= Math.min(range.e.c, 40); c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === "") continue;
          const t = C.cellText(cell);
          if (!t) continue;
          parts.push(`${XLSX.utils.encode_col(c)}=${t}`);
          cells.push(t);
        }
        if (parts.length) block += `R${r + 1}: ${parts.join(" | ")}\n`;
      }
      out += block;
    }
    const truncated = out.length > maxChars;
    return { text: truncated ? out.slice(0, maxChars) : out, truncated, cells };
  }

  const STANDARD_SCHEMA = `{
  "general": {"info_date": "", "type": "", "config": "", "dom": "", "age": "", "tt": "", "tc": "", "reg": "", "msn": ""},
  "general_extra": [{"label": "", "value": ""}],
  "engines": {
    "manufacturer": "", "model": "",
    "units": [{"position": "LH ENGINE (No 1)", "type": "", "esn": "", "tsn": "", "csn": ""}],
    "modules": [{"unit": "LH ENGINE (No 1)", "name": "Turbomachinery", "sn": "", "tso": "", "cso": "", "tshsi": ""}],
    "llp_units": ["LH ENGINE (No 1) <ESN>"],
    "llps": [{"part": "PT DISK STG 1", "units": [{"limit": "", "csn": "", "remaining": ""}]}]
  },
  "propellers": {
    "manufacturer": "", "type": "",
    "units": [{"position": "LH PROP", "parts": [{"name": "ACTUATOR", "sn": "", "tsn": "", "tso": "", "install": "", "cal": "", "next": "", "limit_fh": "", "rem_fh": "", "limit_m": "", "rem_m": ""}]}],
    "blades": [{"position": "LH", "blades": [{"sn": "", "tsn": "", "tso": "", "install": "", "cal": "", "next": "", "limit_fh": "", "rem_fh": "", "limit_m": "", "rem_m": ""}]}]
  },
  "landing_gears": [{"position": "LH-MLG", "sn": "", "csn": "", "cso": "", "install": "", "cal": "", "limit_m": "", "rem_m": ""}],
  "inspections": [{"name": "1C CHECK", "last": "", "next": "", "interval": "", "remaining": "", "uom": ""}],
  "weights": [{"label": "MAXIMUM TAKE-OFF WEIGHT (MTOW)", "value": ""}],
  "options": [{"text": "", "bold": false}],
  "avionics": [{"ata": "", "component": "", "pn": "", "sn": "", "manufacturer": "", "type": "", "fin": ""}],
  "notes": [""]
}`;

  const ENGINE_SCHEMA = `{
  "general": {"info_date": "", "manufacturer": "", "model": "", "esn": "", "thrust": "", "dom": "", "tsn": "", "csn": "", "tslsv": "", "cslsv": "",
              "last_sv_date": "", "last_sv_mro": "", "last_sv_workscope": "", "status": "", "location": ""},
  "general_extra": [{"label": "", "value": ""}],
  "modules": [{"name": "Fan", "sn": "", "tsn": "", "csn": "", "tso": "", "cso": ""}],
  "llps": [{"module": "HPT", "part": "HPT STAGE 1 DISK", "pn": "", "sn": "", "limit": "", "csn": "", "remaining": ""}],
  "shop_visits": [{"date": "", "mro": "", "tsn": "", "csn": "", "workscope": "", "reason": ""}],
  "options": [{"text": "", "bold": false}],
  "notes": [""]
}`;

  /**
   * source: "workbook" (cell dump), "text" (text pulled from a PDF, Word file, CSV...) or "images" (pages attached as images).
   */
  function extractionPrompt(dump, filename, source) {
    source = source || "workbook";
    const how = source === "workbook"
      ? `The workbook "${filename}" is given below as text: each line is one row ("R12:"), and each cell is "<column letter>=<value as Excel displays it>".`
      : source === "text"
        ? `The document "${filename}" is given below as text extracted from it. Table cells on one line are separated by " | ". Page breaks are marked "### Page N".`
        : `The document "${filename}" is attached as images, one per page, in order. Read every page, including tables and small print.`;
    return `You are reading a technical specification document for ACIA Aero Leasing. It may be an Excel workbook, a PDF or Word spec sheet, a status report or a scan, and different lessors, airlines and MROs lay these out differently. Extract the information into ACIA's standard structure.

First decide what the document describes:
- "aircraft": a whole aircraft (MSN, registration, airframe hours/cycles, installed engines, landing gear...).
- "engine": a standalone engine offered on its own (an ESN with engine times, LLPs and shop visits, and no airframe data).
Answer {"kind": "aircraft", "aircraft": {...}} or {"kind": "engine", "engine": {...}}.

For an ENGINE, fill this structure (example values are illustrations, not data):
${ENGINE_SCHEMA}
Engine field meanings: info_date = the date the data is current to; thrust = thrust or shaft-power rating; tsn/csn = engine time and cycles since new; tslsv/cslsv = since last shop visit; status = e.g. serviceable, QEC'd, on wing, in storage. modules = per-module serial numbers and times. llps = every life-limited part with its module, part number, serial number, life limit, cycles used and cycles remaining. shop_visits = shop visit history, newest first. options = ADs, SBs, modifications or other notes, one line each.

For an AIRCRAFT, fill this structure:

${how}

${STANDARD_SCHEMA}

Aircraft field meanings:
- general: info_date = the date the data is current to; type = aircraft type/model as written (e.g. "72-212A (600)"); config = PAX/cargo/combi; dom = date of manufacture; age = aircraft age in years; tt/tc = airframe total time (hours) and total cycles; reg = registration; msn = manufacturer serial number. Put any other aircraft-level facts in general_extra.
- engines: units = one entry per installed engine (position, engine type, ESN, TSN, CSN). modules = per-engine module data such as Turbomachinery / RGB / fan / core / LPT with serial numbers and time or cycles since overhaul and hot section. llps = life-limited parts: one entry per part, with one {limit, csn, remaining} per engine in the same order as llp_units (llp_units = "<position> <ESN>").
- propellers (turboprops only; leave empty for jets): hub/actuator/assembly data per side, and per-blade data per side.
- landing_gears: one entry per gear leg or component (main gears, nose gear, side braces, drag brace…).
- inspections: scheduled airframe checks and inspections (C-checks, calendar SIs, cycle checks…).
- weights: MTOW, MLW, MZFW, maximum fuel, date of last weighing, including the unit (e.g. "23,000 KG").
- options: modifications, SBs, LOPA and cabin notes, one line each; bold=true for group headings such as "ATA 23" or "LOPA :".
- avionics: one entry per avionics component row.

Rules:
- Copy every value exactly as it appears in the document. Do not calculate, convert units, reformat dates or round numbers, and never invent a value. The only exception is weights, where you may append the unit shown elsewhere in the document.
- Leave a field as "" when the document does not give it, and leave out list entries that have no data. Remove the example entries if they do not apply.
- Ignore helper cells such as "For automatic calculation - don't modify", and ignore Excel errors such as #VALUE! (record them in notes).
- In notes, list anything ambiguous, contradictory (e.g. two different registrations), or that you could not place.
- Answer with the JSON object only: {"kind": ..., "aircraft" or "engine": {...}}.

${source === "images" ? "" : `<document>\n${dump}\n</document>`}`;
  }

  // ---------------------------------------------------------------- guard rail: every extracted value must exist in the workbook
  const norm = (s) => String(s || "").toLowerCase().replace(/\b(kg|kgs|lbs?|fhs?|fhrs|fcs?|mths|months?|hrs|cycles)\b/g, "").replace(/[\s,]/g, "").replace(/\.0+$/, "");
  function verifyAgainstWorkbook(d, cells) {
    const known = new Set(cells.map(norm));
    const nums = new Set(cells.map((c) => parseFloat(String(c).replace(/,/g, ""))).filter((n) => !isNaN(n)));
    const blob = cells.join(" \u0001 ").toLowerCase();
    const ok = (v) => {
      const s = String(v).trim();
      if (!s || s === "-" || s === "*" || /^tbd$|^tba$|^n\/?a$/i.test(s)) return true;
      if (known.has(norm(s))) return true;
      const n = parseFloat(s.replace(/,/g, ""));
      if (!isNaN(n) && /^[-\d,.]+(\s*[a-z]+)?$/i.test(s) && nums.has(n)) return true;
      return s.length >= 4 && blob.includes(s.toLowerCase());
    };
    const problems = [];
    const names = { general: "General", general_extra: "General", engines: "Engines", propellers: "Propellers", landing_gears: "Landing gears",
      inspections: "Inspections", weights: "Weights", options: "Options", avionics: "Avionics", units: "", modules: "", llps: "LLP", parts: "", blades: "Blade",
      manufacturer: "Manufacturer", model: "Model", type: "Type", limit: "Limit", remaining: "Remaining", last: "Last", next: "Next", interval: "Interval",
      uom: "UOM", value: "Value", shop_visits: "Shop visits", tslsv: "TSLSV", cslsv: "CSLSV", last_sv_date: "Last shop visit date",
      last_sv_mro: "Last shop visit MRO", last_sv_workscope: "Workscope", workscope: "Workscope", reason: "Reason", mro: "MRO", thrust: "Rating", status: "Status", location: "Location", module: "Module", text: "Text", ata: "ATA", component: "Component", pn: "P/N", fin: "FIN", esn: "ESN", tso: "TSO", cso: "CSO", tshsi: "TSHSI", tsn: "TSN", csn: "CSN", sn: "S/N" };
    for (const set of [GENERAL, PROP_PART, GEAR]) for (const [k, label] of set) if (!names[k] || names[k] === k) names[k] = label.charAt(0) + label.slice(1).toLowerCase();
    const seg = (k) => (k in names ? names[k] : k);
    const walk = (o, path) => {
      if (Array.isArray(o)) o.forEach((x, i) => {
        const tag = x && typeof x === "object" ? x.position || x.name || x.part || x.label || x.component || `${i + 1}` : `${i + 1}`;
        walk(x, [path, tag].filter(Boolean).join(" › "));
      });
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
        if (["position", "unit", "name", "part", "label", "bold", "llp_units", "notes"].includes(k)) continue;
        walk(v, [path, seg(k)].filter(Boolean).join(" › "));
      }
      else if (typeof o === "string" && !ok(o)) problems.push(`${path}: "${o}" isn't in the source file`);
    };
    walk({ ...d, notes: undefined }, "");
    return problems;
  }

  /** Make whatever Claude returned safe to build from. */
  function cleanEngineData(raw) {
    const d = emptyEngineData();
    if (!raw || typeof raw !== "object") return d;
    const str = (v) => (v === null || v === undefined ? "" : String(v));
    const obj = (o, keys) => Object.fromEntries(keys.map((k) => [k, str(o && o[k])]));
    const arr = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []);
    d.general = obj(raw.general, ENGINE_GENERAL.map(([k]) => k));
    d.general_extra = arr(raw.general_extra).map((x) => ({ label: up(str(x.label)), value: str(x.value) })).filter((x) => x.label && x.value);
    d.modules = arr(raw.modules).map((m) => obj(m, ["name", "sn", "tsn", "csn", "tso", "cso"])).filter((m) => m.name);
    d.llps = arr(raw.llps).map((p) => obj(p, ["module", "part", "pn", "sn", "limit", "csn", "remaining"])).filter((p) => p.part || p.pn);
    d.shop_visits = arr(raw.shop_visits).map((v) => obj(v, ["date", "mro", "tsn", "csn", "workscope", "reason"])).filter((v) => Object.values(v).some(Boolean));
    d.options = arr(raw.options).map((o) => ({ text: str(o.text), bold: !!o.bold })).filter((o) => o.text);
    d.notes = Array.isArray(raw.notes) ? raw.notes.map(str).filter(Boolean) : [];
    return d;
  }

  function cleanData(raw) {
    const d = emptyData();
    if (!raw || typeof raw !== "object") return d;
    const str = (v) => (v === null || v === undefined ? "" : String(v));
    const obj = (o, keys) => Object.fromEntries(keys.map((k) => [k, str(o && o[k])]));
    const arr = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []);
    d.general = obj(raw.general, GENERAL.map(([k]) => k));
    d.general_extra = arr(raw.general_extra).map((x) => ({ label: up(str(x.label)), value: str(x.value) })).filter((x) => x.label && x.value);
    const e = raw.engines || {};
    d.engines.manufacturer = str(e.manufacturer); d.engines.model = str(e.model);
    d.engines.units = arr(e.units).map((u) => obj(u, ["position", ...ENGINE_UNIT.map(([k]) => k)]));
    d.engines.modules = arr(e.modules).map((m) => obj(m, ["unit", "name", ...MODULE.map(([k]) => k)]));
    d.engines.llp_units = Array.isArray(e.llp_units) ? e.llp_units.map(str) : [];
    d.engines.llps = arr(e.llps).map((p) => ({ part: str(p.part), units: arr(p.units).map((u) => obj(u, ["limit", "csn", "remaining"])) })).filter((p) => p.part);
    const p = raw.propellers || {};
    d.propellers.manufacturer = str(p.manufacturer); d.propellers.type = str(p.type);
    d.propellers.units = arr(p.units).map((u) => ({ position: str(u.position), parts: arr(u.parts).map((x) => obj(x, ["name", ...PROP_PART.map(([k]) => k)])) }));
    d.propellers.blades = arr(p.blades).map((b) => ({ position: str(b.position), blades: arr(b.blades).map((x) => obj(x, PROP_PART.map(([k]) => k))) }));
    d.landing_gears = arr(raw.landing_gears).map((g) => obj(g, ["position", ...GEAR.map(([k]) => k)])).filter((g) => Object.values(g).some(Boolean));
    d.inspections = arr(raw.inspections).map((i) => obj(i, ["name", "last", "next", "interval", "remaining", "uom"])).filter((i) => i.name);
    d.weights = arr(raw.weights).map((w) => obj(w, ["label", "value"])).filter((w) => w.value);
    d.options = arr(raw.options).map((o) => ({ text: str(o.text), bold: !!o.bold })).filter((o) => o.text);
    d.avionics = arr(raw.avionics).map((a) => obj(a, ["ata", "component", "pn", "sn", "manufacturer", "type", "fin"])).filter((a) => a.component || a.pn || a.sn);
    d.notes = Array.isArray(raw.notes) ? raw.notes.map(str).filter(Boolean) : [];
    return d;
  }

  /** Cells for verification from free text: whole lines, " | " cells and single tokens. */
  function textCells(text) {
    const out = [];
    for (const line of String(text || "").split(/\n/)) {
      const l = line.trim(); if (!l) continue;
      out.push(l);
      for (const part of l.split(/\s*\|\s*|\t|\s{2,}/)) if (part) out.push(part.trim());
      for (const tok of l.split(/[\s|:;]+/)) if (tok) out.push(tok);
    }
    return out;
  }

  /** Text of a .docx: paragraphs, and table rows as "cell | cell". Needs JSZip. */
  async function docxText(buffer) {
    const zip = await root.JSZip.loadAsync(buffer);
    const f = zip.file("word/document.xml");
    if (!f) throw new Error("This Word file has no readable body.");
    const doc = new DOMParser().parseFromString(await f.async("string"), "application/xml");
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const text = (el) => [...el.getElementsByTagNameNS(W, "t")].map((t) => t.textContent).join("");
    const lines = [];
    const body = doc.getElementsByTagNameNS(W, "body")[0];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.localName === "p") { const t = text(child).trim(); if (t) lines.push(t); }
        else if (child.localName === "tbl") {
          for (const tr of child.getElementsByTagNameNS(W, "tr")) {
            const cells = [...tr.children].filter((c) => c.localName === "tc").map((tc) => text(tc).trim());
            if (cells.some(Boolean)) lines.push(cells.join(" | "));
          }
        } else if (child.children && child.children.length) walk(child);
      }
    };
    if (body) walk(body);
    return lines.join("\n");
  }

  root.SpecNormalize = { textCells, docxText, standardEngineSpec, cleanEngineData, templateToData, standardSpec, coverage, workbookDump, extractionPrompt, verifyAgainstWorkbook, cleanData, emptyData };
})(typeof window !== "undefined" ? window : globalThis);
