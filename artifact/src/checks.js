/* ===== Pre-send checks: data problems, recalculated figures, stale data =====
   SpecChecks.run(spec, {today, staleDays}) -> [{level, group, text, fix?}]
   level: "error" (must look at) | "warn" (should look at) | "info"
   fix:   {s, r, c, value}  section index, row index, cell index (-1 = a Fields row's value) and the corrected value. */
(function (root) {
  "use strict";
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const ERR = /^#(VALUE!|REF!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|ERROR)/i;
  const up = (s) => String(s || "").toUpperCase();
  const DAY = 86400000, MONTH_DAYS = 30.4375;

  // ---------------------------------------------------------------- parsing and formatting
  function parseDate(s) {
    s = String(s || "").trim();
    let m = s.match(/^(\d{1,2})[\s\-\/.]([A-Za-z]{3})[A-Za-z]*[\s\-\/.,]+(\d{2}|\d{4})$/);
    if (m) {
      const mon = MONTHS.indexOf(m[2].toLowerCase());
      if (mon < 0) return null;
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return Date.UTC(y, mon, +m[1]);
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/); // day/month/year, as in European sheets
    if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return Date.UTC(y, +m[2] - 1, +m[1]); }
    return null;
  }
  const fmtDate = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCFullYear()}`; };

  /** "25,000 FHs" -> {n: 25000, decimals: 0, commas: true, suffix: " FHs"}; null for "-", "*", "TBD"... */
  function parseNum(s) {
    const t = String(s || "").trim().replace(/^[–—]/, "-");
    const m = t.match(/^(-?)\s*(\d[\d,]*)(?:\.(\d*))?\s*([A-Za-z].*)?$/);
    if (!m) return null;
    const n = parseFloat(`${m[1]}${m[2].replace(/,/g, "")}.${m[3] || "0"}`);
    return { n, decimals: (m[3] || "").length, commas: m[2].includes(","), suffix: m[4] ? " " + m[4].trim() : "" };
  }
  function fmtLike(n, like, defaults) {
    const d = like || defaults || { decimals: 0, commas: true, suffix: "" };
    let s = Math.abs(n).toFixed(d.decimals);
    if (d.commas || Math.abs(n) >= 10000) { const [i, f] = s.split("."); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? "." + f : ""); }
    return (n < 0 ? "-" : "") + s + (d.suffix || "");
  }
  const monthsBetween = (a, b) => (b - a) / DAY / MONTH_DAYS;
  function addMonths(t, months) {
    const d = new Date(t);
    const whole = Math.trunc(months);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + whole, d.getUTCDate());
  }

  // ---------------------------------------------------------------- the checks
  function run(spec, opts) {
    const today = (opts && opts.today) || Date.now();
    const staleDays = (opts && opts.staleDays) || 90;
    const out = [];
    const sections = spec.sections || [];
    const isEngine = spec.cover && spec.cover.kind === "engine";
    let heading = "";
    const nameOf = [];
    sections.forEach((s, i) => { if (s.type === "heading") heading = s.title || ""; nameOf[i] = s.title || heading || "Section"; });

    const kvGet = (re) => {
      for (let i = 0; i < sections.length; i++) { const s = sections[i]; if (s.type !== "kv") continue;
        for (let r = 0; r < s.rows.length; r++) if (re.test(up(s.rows[r].label))) return { s: i, r, value: s.rows[r].value || "" }; }
      return null;
    };
    const infoRow = kvGet(/INFORMATION DATE|STATUS DATE|SITUATION DATE/);
    const asOf = infoRow ? parseDate(infoRow.value) : null;

    // --- 1. data problems
    let tbd = 0;
    sections.forEach((s, i) => {
      const cells = s.type === "kv" ? s.rows.map((r, ri) => ({ v: r.value, ri, ci: -1, label: r.label }))
        : s.type === "grid" ? s.rows.flatMap((r, ri) => r.cells.map((v, ci) => ({ v, ri, ci, label: `${r.label} › ${s.columns[ci] || ""}` }))) : [];
      const errs = [];
      for (const c of cells) {
        const v = String(c.v || "").trim();
        if (ERR.test(v)) errs.push(c);
        if (/^(TBD|TBA)$/i.test(v)) tbd++;
      }
      if (errs.length === 1) out.push({ level: "error", group: "Data", text: `${nameOf[i]} › ${errs[0].label}: Excel error ${errs[0].v}` });
      else if (errs.length > 1) {
        const rows = [...new Set(errs.map((c) => (s.type === "grid" ? (s.rows[c.ri].cells[0] && !ERR.test(s.rows[c.ri].cells[0]) ? s.rows[c.ri].cells[0] : `row ${c.ri + 1}`) : s.rows[c.ri].label)))];
        out.push({ level: "error", group: "Data", text: `${nameOf[i]}: ${errs.length} cells show Excel errors (${[...new Set(errs.map((c) => String(c.v).trim()))].join(", ")}) in ${rows.slice(0, 8).join(", ")}${rows.length > 8 ? "…" : ""}` });
      }
      if (s.type === "kv" && /GENERAL/.test(up(s.title))) for (const r of s.rows) if (!String(r.value || "").trim())
        out.push({ level: "warn", group: "Data", text: `General Description › ${r.label} is empty` });
      if (s.type === "grid" && /AVIONIC/.test(up(s.title))) s.rows.forEach((r) => {
        if (parseNum(r.cells[0]) && /^[\d.,\s-]+$/.test(String(r.cells[0]))) out.push({ level: "warn", group: "Data", text: `Avionics: component name "${r.cells[0]}" is a number (ATA ${r.label}), probably a broken formula` });
      });
    });
    if (tbd) out.push({ level: "info", group: "Data", text: `${tbd} value${tbd > 1 ? "s are" : " is"} still TBD or TBA` });
    const serial = kvGet(isEngine ? /ENGINE SERIAL|^ESN$/ : /AIRCRAFT SERIAL|^MSN$/);
    if (serial && serial.value && spec.cover && spec.cover.msn && String(serial.value).trim() !== String(spec.cover.msn).trim())
      out.push({ level: "error", group: "Data", text: `The cover says ${isEngine ? "ESN" : "MSN"} ${spec.cover.msn} but the General Description says ${serial.value}` });

    // --- 3. stale data
    if (!infoRow || !infoRow.value) out.push({ level: "warn", group: "Data age", text: "No information date, so readers can't tell how current the figures are" });
    else if (asOf === null) out.push({ level: "info", group: "Data age", text: `Information date "${infoRow.value}" isn't a date the app can read, so derived figures weren't recalculated` });
    else {
      const age = Math.floor((today - asOf) / DAY);
      if (age > staleDays) out.push({ level: "warn", group: "Data age", text: `The data is ${age} days old (information date ${infoRow.value}). Hours, cycles and remaining figures will have moved on since then.` });
      if (age < -1) out.push({ level: "warn", group: "Data age", text: `The information date ${infoRow.value} is in the future` });
    }

    // --- 2. recalculated figures (all relative to the information date)
    const calc = (i, ri, ci, label, stated, computed, like, tol, defaults) => {
      if (Math.abs(stated.n - computed) <= tol) return;
      out.push({ level: "warn", group: "Calculations", text: `${nameOf[i]} › ${label}: shows ${fmtLike(stated.n, stated)}, should be ${fmtLike(computed, like, defaults)}`,
                 fix: { s: i, r: ri, c: ci, value: fmtLike(computed, like, defaults) } });
    };
    const overdue = (i, label, p) => { if (p && p.n < 0) out.push({ level: "error", group: "Overdue", text: `${nameOf[i]} › ${label}: ${fmtLike(p.n, p)} remaining (overdue or expired)` }); };

    if (asOf !== null) {
      const dom = kvGet(/DATE OF MANUFACTURE/), age = kvGet(/AGE/);
      const domT = dom ? parseDate(dom.value) : null, ageP = age ? parseNum(age.value) : null;
      if (domT !== null && ageP) {
        const years = (asOf - domT) / DAY / 365.25;
        if (Math.abs(years - ageP.n) > 0.05) out.push({ level: "warn", group: "Calculations", text: `A/C age: shows ${age.value}, should be ${years.toFixed(2)} at the information date`,
          fix: { s: age.s, r: age.r, c: -1, value: years.toFixed(2) } });
      }
    }
    const tt = kvGet(/TOTAL TIME|AIRFRAME.*HOURS/), tc = kvGet(/TOTAL CYCLES/);
    const ttN = tt ? parseNum(tt.value) : null, tcN = tc ? parseNum(tc.value) : null;
    const months = { decimals: 2, commas: false, suffix: " mths" };

    sections.forEach((s, i) => {
      if (s.type !== "grid") return;
      const title = up(s.title);
      // Life-limited parts: Remaining = Limit - used
      if (/LIFE|LLP|ROTABLE/.test(title)) {
        const cols = (re) => s.columns.map((c, ci) => (re.test(up(c)) ? ci : -1)).filter((ci) => ci >= 0);
        const L = cols(/LIMIT/), U = cols(/CSN|TSN|USED/), R = cols(/REMAIN/);
        s.rows.forEach((r, ri) => R.forEach((rc, k) => {
          const lim = parseNum(r.cells[L[k]]), used = parseNum(r.cells[U[k]]), rem = parseNum(r.cells[rc]);
          overdue(i, `${r.label} › ${s.columns[rc]}`, rem);
          if (lim && used && rem) calc(i, ri, rc, `${r.label} remaining`, rem, lim.n - used.n, rem, 1.5);
        }));
        return;
      }
      // Scheduled inspections: remaining to the next due point
      if (/INSPECTION|CHECK/.test(title)) {
        const col = (re) => s.columns.findIndex((c) => re.test(up(c)));
        const cNext = col(/NEXT/), cRem = col(/REMAIN/), cUom = col(/UOM|UNIT/);
        if (cRem < 0) return;
        s.rows.forEach((r, ri) => {
          const rem = parseNum(r.cells[cRem]);
          overdue(i, r.label, rem);
          if (!rem || cNext < 0) return;
          const uom = up(cUom >= 0 ? r.cells[cUom] : r.cells[cRem]);
          if (/MONTH|MTH/.test(uom) && asOf !== null) {
            const next = parseDate(r.cells[cNext]);
            if (next !== null) calc(i, ri, cRem, `${r.label} remaining`, rem, monthsBetween(asOf, next), rem, 1);
          } else if (/FH|HOUR|HRS/.test(uom) && ttN) {
            const next = parseNum(r.cells[cNext]); if (next) calc(i, ri, cRem, `${r.label} remaining`, rem, next.n - ttN.n, rem, 1);
          } else if (/CYC|FC/.test(uom) && tcN) {
            const next = parseNum(r.cells[cNext]); if (next) calc(i, ri, cRem, `${r.label} remaining`, rem, next.n - tcN.n, rem, 1);
          }
        });
        return;
      }
      // Unit tables (propellers, blades, landing gear): one column per component, one row per field
      const row = (re, not) => s.rows.findIndex((r) => re.test(up(r.label)) && !(not && not.test(up(r.label))));
      const rInst = row(/INSTALL|LAST OV/), rCal = row(/CALENDAR/), rLimM = row(/LIMIT.*(MNTH|MONTH)|^OVERHAUL LIMIT$/),
            rRemM = row(/REMAINING.*(MNTH|MONTH)/), rLimH = row(/LIMIT.*(FH|HRS)/), rRemH = row(/REMAINING.*(FH|HRS)|REMAINING TO OV/),
            rTso = row(/TSO|TIME SINCE OVERHAUL/), rNext = row(/NEXT/);
      s.columns.forEach((colName, ci) => {
        const cell = (ri) => (ri >= 0 ? s.rows[ri].cells[ci] : "");
        const label = (ri) => `${colName} › ${s.rows[ri].label}`;
        overdue(i, rRemM >= 0 ? label(rRemM) : "", rRemM >= 0 ? parseNum(cell(rRemM)) : null);
        overdue(i, rRemH >= 0 ? label(rRemH) : "", rRemH >= 0 ? parseNum(cell(rRemH)) : null);
        const inst = rInst >= 0 ? parseDate(cell(rInst)) : null;
        let consumed = null;
        if (inst !== null && asOf !== null) {
          consumed = monthsBetween(inst, asOf);
          const cal = rCal >= 0 ? parseNum(cell(rCal)) : null;
          if (cal) calc(i, rCal, ci, label(rCal), cal, consumed, cal, 0.5, months);
        }
        const limM = rLimM >= 0 ? parseNum(cell(rLimM)) : null, remM = rRemM >= 0 ? parseNum(cell(rRemM)) : null;
        if (limM && remM && consumed !== null) calc(i, rRemM, ci, label(rRemM), remM, limM.n - consumed, remM, 0.5, months);
        if (limM && inst !== null && rNext >= 0) {
          const next = parseDate(cell(rNext)), due = addMonths(inst, limM.n);
          if (next !== null && Math.abs(next - due) > 31 * DAY)
            out.push({ level: "warn", group: "Calculations", text: `${nameOf[i]} › ${label(rNext)}: shows ${cell(rNext)}, should be ${fmtDate(due)} (${limM.n} months after ${cell(rInst)})`,
                       fix: { s: i, r: rNext, c: ci, value: fmtDate(due) } });
        }
        const limH = rLimH >= 0 ? parseNum(cell(rLimH)) : null, remH = rRemH >= 0 ? parseNum(cell(rRemH)) : null, tso = rTso >= 0 ? parseNum(cell(rTso)) : null;
        if (limH && remH && tso) calc(i, rRemH, ci, label(rRemH), remH, limH.n - tso.n, remH, 1);
      });
    });

    const rank = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /** Apply one fix to a spec (mutates it). */
  function applyFix(spec, fix) {
    const s = spec.sections[fix.s];
    if (!s) return;
    if (fix.c === -1 && s.rows[fix.r]) s.rows[fix.r].value = fix.value;
    else if (s.rows[fix.r]) s.rows[fix.r].cells[fix.c] = fix.value;
  }

  /** Days since an information date string, or null. */
  function dataAgeDays(infoDate, today) {
    const t = parseDate(infoDate);
    return t === null ? null : Math.floor(((today || Date.now()) - t) / DAY);
  }

  root.SpecChecks = { run, applyFix, dataAgeDays, parseDate, parseNum };
})(typeof window !== "undefined" ? window : globalThis);
