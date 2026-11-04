/* ===== Spec Sheet Builder: UI, storage (db + assets), preview, download, AI changes ===== */
(function () {
  "use strict";
  const C = window.SpecCore;
  const A = window.SPEC_ASSETS; // logos + Archivo fonts for the PDF

  // ------------------------------------------------------------ small helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const $view = document.getElementById("view");
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const nowIso = () => new Date().toISOString();
  const when = (iso) => { if (!iso) return ""; const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); };
  let uidCounter = 0;
  const fid = (p) => `${p}-${++uidCounter}`;

  function toast(msg, err) {
    const el = h("div", { class: err ? "err" : "" }, msg);
    document.getElementById("toasts").append(el);
    setTimeout(() => el.remove(), err ? 7000 : 3200);
    return el;
  }
  /** A progress message that counts the seconds, so a long read never looks like nothing is happening. */
  function busy(msg) {
    const t0 = Date.now(), secs = h("span", { class: "small" }, "");
    const el = h("div", { class: "busy" }, h("span", { class: "spin" }), " ", msg, " ", secs);
    document.getElementById("toasts").append(el);
    const timer = setInterval(() => { const n = Math.round((Date.now() - t0) / 1000); secs.textContent = n >= 3 ? `(${n} s)` : ""; }, 1000);
    return () => { clearInterval(timer); el.remove(); };
  }
  /** Reject if a platform call hasn't answered in ms milliseconds. */
  const withTimeout = (p, ms, message) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms))]);

  /** In-page dialog. actions: [{label, cls, run}] — run may return false to keep the dialog open. */
  function dialog(title, body, actions) {
    const close = () => scrim.remove();
    const scrim = h("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) close(); } },
      h("div", { class: "dialog", role: "dialog", "aria-label": title }, h("h2", {}, title), body,
        h("div", { class: "acts" }, (actions || [{ label: "Close" }]).map((a) =>
          h("button", { class: "btn " + (a.cls || ""), onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            try { if (!a.run || (await a.run()) !== false) close(); } catch (err) { toast(err.message || String(err), true); }
            finally { b.disabled = false; }
          } }, a.label)))));
    document.getElementById("dialogs").append(scrim);
    return close;
  }
  const confirmDialog = (title, text, okLabel, cls) => new Promise((resolve) => {
    dialog(title, h("p", {}, text), [{ label: "Cancel", run: () => resolve(false) }, { label: okLabel, cls: cls || "primary", run: () => resolve(true) }]);
  });

  function changesTable(changes, limit) {
    limit = limit || 400;
    if (!changes.length) return h("p", { class: "muted" }, "No values changed.");
    return h("div", { class: "changes-wrap" }, h("table", { class: "changes" },
      h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Was"), h("th", {}, "Now"))),
      h("tbody", {}, changes.slice(0, limit).map((c) => h("tr", {}, h("td", {}, c.field), h("td", { class: "old" }, c.old), h("td", { class: "new" }, c.new))))),
      changes.length > limit ? h("p", { class: "small muted" }, `…and ${changes.length - limit} more`) : null);
  }
  function warningsBox(w) {
    if (!w || !w.length) return null;
    return h("div", { class: "warnbox" }, h("strong", {}, `Check ${w.length} item${w.length > 1 ? "s" : ""} in the source file before sending this out:`),
      h("ul", {}, w.slice(0, 30).map((x) => h("li", {}, x))), w.length > 30 ? h("div", {}, `…and ${w.length - 30} more`) : null);
  }
  function pickFile(accept, cb) {
    const inp = h("input", { type: "file", accept, style: "position:fixed;left:-999px", onchange: () => { const f = inp.files[0]; inp.remove(); if (f) cb(f); } });
    document.body.append(inp); inp.click();
  }

  // ------------------------------------------------------------ page parts, in ACIA Commercial's pattern
  /** The navy cover: crumbs [text | [text, hash]], title, sub (under the title), lede, actions, side (a glance card). */
  function coverEl({ crumbs, title, sub, badge, lede, actions, side, compact }) {
    const cr = (crumbs || []).flatMap((c, i) => [i ? h("span", { "aria-hidden": "true" }, "·") : null,
      Array.isArray(c) ? h("button", { class: "crumb", onclick: () => (location.hash = c[1]) }, c[0]) : h("span", {}, c)]);
    return h("section", { class: "cover" + (compact ? " compact" : "") }, h("div", { class: "shell" + (side ? " cover-grid" : "") },
      h("div", {}, cr.length ? h("p", { class: "eyebrow-line" }, cr) : null,
        h("h1", {}, title, badge || null, sub ? h("span", { class: "t-sub" }, sub) : null),
        lede ? h("p", { class: "lede" }, lede) : null,
        actions && actions.length ? h("div", { class: "cover-actions" }, actions) : null),
      side || null));
  }
  /** A glance card for the cover's side: rows [{l, s, v, vs, tone, onClick}]. */
  function glance(title, rows, empty) {
    return h("aside", { class: "side" }, h("div", { class: "side-h" }, title),
      rows.length ? rows.map((r) => h("button", { class: "side-row", onclick: r.onClick || null },
        h("span", {}, r.l, r.s ? h("small", {}, r.s) : null), h("b", { class: r.tone || "" }, r.v, r.vs ? h("small", {}, r.vs) : null)))
        : h("p", { class: "side-empty" }, empty || "Nothing yet."));
  }
  /** The strip of figures riding the cover's lower edge: [{l, v, s, tone, bar: 0..1}]. */
  function kpiStrip(list) {
    return h("div", { class: "shell" }, h("div", { class: "kpis", style: `--n:${list.length}` }, list.map((k) =>
      h("div", { class: "kpi" + (k.tone ? " " + k.tone : "") }, h("span", { class: "l" }, k.l), h("span", { class: "v" }, k.v), h("span", { class: "s" }, k.s || "\u00a0"),
        k.bar !== undefined ? h("span", { class: "kbar" + (k.tone ? " " + k.tone : "") }, h("i", { style: `width:${Math.round(Math.max(0, Math.min(1, k.bar)) * 100)}%` })) : null))));
  }
  /** A section: eyebrow, heading, a line under it, an optional control on the right, then its body. */
  function secEl({ eyebrow, title, lede, right, id }, ...body) {
    return h("section", { class: "psec", id: id || null }, h("div", { class: "shell" },
      h("div", { class: "psec-head" }, h("div", {}, eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null, h("h2", {}, title), lede ? h("p", {}, lede) : null), right || null),
      body));
  }

  // ------------------------------------------------------------ platform capabilities
  const cap = { db: null, user: null, assets: null, downloads: null, sample: null };
  let me = null, canWrite = true, canAssets = false;
  const DEFAULT_SETTINGS = {
    company: "ACIA Aero Leasing", doc_title: "Specifications & Summary of Terms", confidential: "STRICTLY PRIVATE AND CONFIDENTIAL",
    contacts_heading: "For Additional Summary, Please Contact:", contacts: [], disclaimer: "",
    stale_days: 90, // flag data older than this many days
    font: null, // brand font: {family, normal, bold, italics, bolditalics} -> asset ids
  };
  let settings = clone(DEFAULT_SETTINGS);
  let settingsLoaded = false;
  let fleet = []; let fleetLoaded = false; let fleetError = "";

  const aid = (msn) => "msn-" + String(msn).trim().replace(/[^A-Za-z0-9_.\-]/g, "_");
  const vid = (n) => "v" + String(n).padStart(5, "0");

  async function boot() {
    document.getElementById("mast-logo").src = A.logoWhite;
    window.addEventListener("hashchange", route);
    window.addEventListener("beforeunload", (e) => { if (ws && ws.dirty) { e.preventDefault(); e.returnValue = ""; } });
    route();
    const [db, user, assets, downloads, sample] = await Promise.all(["db", "user", "assets", "downloads", "sample"].map((n) => window.claude?.use?.(n).catch(() => null) ?? Promise.resolve(null)));
    Object.assign(cap, { db, user, assets, downloads, sample });
    canAssets = !!assets;
    if (user) {
      try { me = await user.id(); } catch (_) { me = null; }
      try { const w = await user.can("data.write"); if (w === false) canWrite = false; } catch (_) {}
    }
    if (currentRoute() === "prefs") renderSettings();
    if (!db) { fleetError = "Sign in to claude.ai to see and save spec sheets."; fleetLoaded = true; route(); return; }
    db.doc("config/settings").onSnapshot((s) => { settings = { ...clone(DEFAULT_SETTINGS), ...(s.exists ? s.data() : {}) }; applyUiFont(); schedulePreview();
      if (!settingsLoaded) { settingsLoaded = true; if (currentRoute() === "prefs") renderSettings(); } }, () => {});
    const timer = setTimeout(() => { if (!fleetLoaded) { fleetError = "The spec sheet store isn't answering yet. Your list will appear when it does."; route(); } }, 10000);
    db.collection("aircraft").onSnapshot((snap) => {
      fleet = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => !a.archived)
        .sort((a, b) => (parseInt(a.msn, 10) || 0) - (parseInt(b.msn, 10) || 0));
      if (!snap.metadata.fromCache) { fleetLoaded = true; fleetError = ""; clearTimeout(timer); }
      if (currentRoute() === "fleet") renderFleet();
      if (ws) checkNewerVersion();
    }, (e) => { clearTimeout(timer); fleetLoaded = true; fleetError = "Couldn't load spec sheets: " + e.message; if (currentRoute() === "fleet") renderFleet(); });
  }

  async function names(ids) {
    const out = {};
    const list = [...new Set(ids.filter(Boolean))];
    if (!cap.user || !list.length) return out;
    try { const ps = await cap.user.profiles(list); for (const id of list) out[id] = (ps[id] && ps[id].name) || "Someone"; } catch (_) {}
    return out;
  }

  // ------------------------------------------------------------ routing
  let ws = null;
  const currentRoute = () => { const x = (location.hash || "#fleet").slice(1); return x.startsWith("ac-") ? "ac" : x === "prefs" ? "prefs" : "fleet"; };
  async function route() {
    const r = currentRoute();
    document.getElementById("dialogs").replaceChildren();
    if (r === "fleet" || r === "ac") document.getElementById("nav-fleet").setAttribute("aria-current", "page"); else document.getElementById("nav-fleet").removeAttribute("aria-current");
    if (r === "prefs") document.getElementById("nav-prefs").setAttribute("aria-current", "page"); else document.getElementById("nav-prefs").removeAttribute("aria-current");
    if (r !== "ac" && ws && ws.dirty) {
      const target = location.hash;
      history.replaceState(null, "", "#ac-" + ws.id);
      if (await confirmDialog("Unsaved changes", `MSN ${ws.spec.cover.msn} has changes that are not saved yet.`, "Leave without saving", "danger")) { ws.dirty = false; location.hash = target; }
      return;
    }
    if (r === "ac") return openAircraft(location.hash.slice(4));
    ws = null;
    if (r === "prefs") return renderSettings();
    renderFleet();
  }

  // ------------------------------------------------------------ fleet
  function renderFleet() {
    const stale = settings.stale_days || 90;
    const age = (a) => window.SpecChecks.dataAgeDays(a.info_date);
    const aircraft = fleet.filter((a) => a.kind !== "engine"), engines = fleet.filter((a) => a.kind === "engine");
    const old = fleet.filter((a) => { const d = age(a); return d !== null && d > stale; });
    const month = fleet.filter((a) => a.updated_at && Date.now() - new Date(a.updated_at) < 30 * 86400000);
    const idLabel = (a) => `${a.kind === "engine" ? "ESN" : "MSN"} ${a.msn}`;
    const upload = () => pickFile(ACCEPT, (f) => importExcel(f));

    const title = !fleet.length ? "Spec sheets, ready to send"
      : old.length ? `${old.length} of ${fleet.length} spec sheet${fleet.length > 1 ? "s" : ""} need${old.length === 1 ? "s" : ""} fresh data`
      : `${fleet.length} spec sheet${fleet.length > 1 ? "s" : ""}, all current`;
    const byAge = [...fleet].sort((a, b) => (age(b) ?? -1) - (age(a) ?? -1)).slice(0, 5);
    const side = glance("Data age, oldest first", byAge.map((a) => {
      const d = age(a);
      return { l: idLabel(a), s: [a.model, a.registration].filter(Boolean).join(" · "), v: d === null ? "–" : `${d} days`, vs: a.info_date || "no date",
               tone: d !== null && d > stale ? "warn" : "good", onClick: () => (location.hash = "#ac-" + a.id) };
    }), "Upload a spec sheet to see how current each one is.");
    const cover = coverEl({ crumbs: ["Spec sheets"], title,
      lede: "Upload an aircraft or engine spec in any format: Excel, PDF, Word or a scan. Each one is checked, kept with every version, and downloaded as the ACIA spec sheet PDF.",
      actions: [canWrite && cap.db ? h("button", { class: "btn light", onclick: upload }, "Upload spec sheet") : null,
        h("button", { class: "btn glass", onclick: () => (location.hash = "#prefs") }, "Settings")].filter(Boolean),
      side });
    const kpis = kpiStrip([
      { l: "Aircraft", v: String(aircraft.length), s: "spec sheets" },
      { l: "Engines", v: String(engines.length), s: "spec sheets" },
      { l: "Current", v: String(fleet.length - old.length), s: `data under ${stale} days old`, tone: "good", bar: fleet.length ? (fleet.length - old.length) / fleet.length : 0 },
      { l: "Need fresh data", v: String(old.length), s: `over ${stale} days old`, tone: old.length ? "warn" : "", bar: fleet.length ? old.length / fleet.length : 0 },
      { l: "Updated", v: String(month.length), s: "in the last 30 days" },
    ]);

    const drop = h("div", { class: "drop" },
      h("div", { class: "glyph", "aria-hidden": "true" }, "XLS", h("br"), "PDF"),
      h("div", { class: "grow" }, h("strong", {}, "Drop a spec sheet here"),
        h("div", { class: "small muted" }, "Excel, PDF (including scans), Word, CSV or a photo, in any layout. A new MSN or ESN creates a spec sheet; one already here gets a new version, and you'll see every value that changed.")),
      h("button", { class: "btn primary", disabled: !cap.db || !canWrite, onclick: upload }, "Upload spec sheet"));
    if (cap.db && canWrite) {
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) importExcel(f); });
    }
    let list;
    if (!fleetLoaded && !fleetError) list = h("div", { class: "panel empty" }, h("span", { class: "spin" }), " Loading spec sheets…");
    else if (fleetError && !fleet.length) list = h("div", { class: "panel empty" }, fleetError);
    else if (!fleet.length) list = h("div", { class: "panel empty" }, h("h2", {}, "No spec sheets yet"), h("p", {}, "Upload a spec sheet for an aircraft or an engine to create the first one."));
    else list = h("div", { class: "fleet" }, fleet.map((a) => {
      const d = age(a);
      return h("button", { class: "tail", onclick: () => (location.hash = "#ac-" + a.id) },
        h("div", { class: "top" }, h("span", {}, h("span", { class: "kind" }, a.kind === "engine" ? "ESN " : "MSN "), h("span", { class: "msn" }, a.msn)),
          h("span", { class: "model" }, a.model || ""), a.registration ? h("span", { class: "pill acc reg" }, a.registration) : null),
        h("dl", {},
          h("dt", {}, "Information date"), h("dd", {}, a.info_date || "–", " ", d !== null && d > stale ? h("span", { class: "pill warn" }, `${d} days old`) : d !== null ? h("span", { class: "pill good" }, "current") : null),
          h("dt", {}, "Version"), h("dd", {}, `v${a.version || 1}`),
          h("dt", {}, "Updated"), h("dd", {}, when(a.updated_at)),
          h("dt", {}, "Last change"), h("dd", {}, a.last_change || "")));
    }));
    $view.replaceChildren(cover, kpis,
      secEl({ eyebrow: "The fleet", title: fleet.length ? "Every spec sheet" : "Start with a spec sheet",
              lede: "Open one to edit it, run the checks before sending and download its PDF.", right: !canWrite ? h("span", { class: "pill" }, "View only") : null },
        canWrite ? drop : null, list));
  }

  // ------------------------------------------------------------ Excel import
  async function sha(bytes) {
    try { const d = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(""); }
    catch (_) { return String(bytes.length); }
  }

  async function uploadImage(bytes, type) {
    if (!cap.assets) return null;
    const r = await cap.assets.upload(new Blob([bytes], { type }));
    return r.id;
  }

  function mergeReimport(old, fresh) {
    const key = (list) => { const m = new Map(); let hd = ""; for (const s of list) { if (s.type === "heading") hd = s.title; m.set(`${s.type}|${hd}|${s.title}`, s); } return m; };
    const oldK = key(old.sections || []);
    for (const [k, s] of key(fresh.sections)) if (oldK.has(k)) { s.page_break_before = oldK.get(k).page_break_before; s.hidden = !!oldK.get(k).hidden; }
    if (old.cover && old.cover.model) fresh.cover.model = old.cover.model;
    const keepExcel = new Map((old.attachments || []).filter((a) => a.origin === "excel").map((a) => [a.hash, a]));
    fresh.attachments = [...(old.attachments || []).filter((a) => a.origin !== "excel"),
      ...fresh.attachments.map((a) => keepExcel.has(a.hash) ? { ...a, hidden: keepExcel.get(a.hash).hidden, title: keepExcel.get(a.hash).title } : a)];
    return fresh;
  }

  async function importExcel(file, intoId) {
    if (!cap.db) return toast("Sign in to claude.ai to save spec sheets.", true);
    let done = busy(`Reading ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const { spec, warnings, checks, method, source } = await readDocument(file, buf, (msg) => { done(); done = busy(msg); });
      const msn = spec.cover.msn;
      const isEngine = spec.cover.kind === "engine";
      const idLabel = isEngine ? "ESN" : "MSN";
      if (!msn) throw new Error(isEngine ? "Couldn't find the engine serial number (ESN) in this workbook." : "Couldn't find the aircraft serial number (MSN) in this workbook. Add it to the workbook and upload it again.");
      const id = intoId || (isEngine ? "esn-" + String(msn).trim().replace(/[^A-Za-z0-9_.\-]/g, "_") : aid(msn));
      const sumRef = cap.db.doc("aircraft/" + id);
      const sum = await sumRef.get();
      const prev = sum.exists && !sum.data().archived ? await cap.db.doc(`aircraft/${id}/versions/${vid(sum.data().version)}`).get() : null;
      const prevSpec = prev && prev.exists ? prev.data().spec : null;
      if (intoId && prevSpec && prevSpec.cover.msn && String(prevSpec.cover.msn) !== String(msn)) warnings.unshift(`This workbook is for ${idLabel} ${msn}, but you uploaded it to ${prevSpec.cover.kind === "engine" ? "ESN" : "MSN"} ${prevSpec.cover.msn}.`);

      // Images in the workbook body (LOPA) become extra pages; identical images are reused, not re-uploaded.
      const imgs = EXCEL.test(file.name) ? await C.workbookImages(buf).catch(() => []) : [];
      const previous = new Map(((prevSpec && prevSpec.attachments) || []).filter((a) => a.hash).map((a) => [a.hash, a]));
      for (const im of imgs) {
        const hash = await sha(im.data);
        let asset = previous.get(hash) && previous.get(hash).asset;
        if (!asset && cap.assets) {
          try { asset = await uploadImage(im.data, "image/" + (im.ext === "jpg" ? "jpeg" : im.ext)); } catch (e) { warnings.push("Couldn't store the LOPA image from the workbook: " + (e.message || e.code)); }
        }
        if (asset) spec.attachments.push({ id: C.newId(), title: im.title, asset, hash, origin: "excel", hidden: false });
        else if (!cap.assets) warnings.push("The workbook has a LOPA image, but only editors of this artifact can store images. Ask an editor to upload it.");
      }
      const finalSpec = prevSpec ? mergeReimport(prevSpec, spec) : spec;
      const changes = C.diff(prevSpec, finalSpec);
      await saveVersion(id, finalSpec, "Excel upload", file.name, sum.exists && !sum.data().archived ? sum.data().version : 0);
      done();
      dialog(prevSpec ? `${idLabel} ${msn} updated` : `${idLabel} ${msn} added`,
        h("div", {}, h("p", {}, prevSpec ? `Saved as a new version. ${changes.length} value${changes.length === 1 ? "" : "s"} changed since the previous version.` : isEngine ? "A new engine spec sheet was created from the file." : "A new spec sheet was created from the file."),
          method === "claude" ? h("p", { class: "small muted" }, source === "images"
            ? "Claude read the page images into the standard layout."
            : "This file isn't in the usual Excel template, so Claude read it into the standard layout. Every value was checked against the file's text.") : null,
          checks && checks.length ? h("div", { class: "warnbox" }, h("strong", {}, `${checks.length} value${checks.length > 1 ? "s" : ""} Claude returned couldn't be found in the file. Check them before sending the PDF out:`),
            h("ul", {}, checks.slice(0, 30).map((x) => h("li", {}, x)))) : null,
          warningsBox(warnings), prevSpec ? changesTable(changes) : null),
        [{ label: "Open spec sheet", cls: "primary", run: () => { if (ws && ws.id === id) openAircraft(id, true); else location.hash = "#ac-" + id; } }]);
    } catch (e) { done(); toast(e.message || String(e), true); }
  }

  /**
   * Any workbook -> the standard spec sheet layout.
   * The usual ACIA template is read directly; any other layout is read by Claude into the same structure,
   * and every value Claude returns is checked against the workbook's cells.
   */
  const EXCEL = /\.(xlsx|xlsm|xls)$/i, IMAGE = /\.(png|jpe?g|webp|gif)$/i;
  const ACCEPT = ".xlsx,.xlsm,.xls,.pdf,.docx,.csv,.txt,.png,.jpg,.jpeg,.webp";

  /**
   * Any spec sheet file -> the standard spec sheet layout.
   * - The usual ACIA Excel template is read directly.
   * - Any other Excel layout, PDF, Word, CSV or text file is turned into text and read by Claude;
   *   every value Claude returns is checked against that text.
   * - Scanned PDFs and photos/screenshots are sent to Claude as page images (no text to check against).
   */
  async function readDocument(file, buf, status) {
    const N = window.SpecNormalize;
    const name = file.name || "upload";
    if (EXCEL.test(name)) {
      const parsed = C.importWorkbook(buf, name);
      const data = N.templateToData(parsed.spec);
      if (N.coverage(data) >= 0.6) return { spec: N.standardSpec(data, name), warnings: parsed.warnings, checks: [], method: "template" };
      status("This workbook has a different layout. Claude is reading it into the standard format…");
      const limits = await sampleLimits();
      const dump = N.workbookDump(buf, maxChars(limits));
      return extractWithClaude({ text: dump.text, cells: dump.cells, truncated: dump.truncated, source: "workbook", name, limits });
    }
    if (!cap.sample) throw new Error("Reading a file that isn't in the usual Excel template needs Claude, which isn't available in this view. Open the artifact on claude.ai and upload it there.");
    const limits = await sampleLimits();
    let text = "";
    if (/\.(csv|txt)$/i.test(name)) text = new TextDecoder().decode(buf);
    else if (/\.docx$/i.test(name)) { status("Reading the Word document…"); text = await N.docxText(buf); }
    else if (/\.pdf$/i.test(name)) {
      status("Reading the PDF…");
      const pdf = await window.pdfjsLib.getDocument({ data: buf.slice() }).promise;
      text = await pdfToText(pdf);
      if (text.replace(/\s|#|Page|\d/g, "").length < 200 * pdf.numPages * 0.25) { // little or no text layer: a scan
        status("This PDF is a scan. Claude is reading the page images…");
        const images = await pdfToImages(pdf, limits);
        return extractWithClaude({ images, source: "images", name, limits, pagesSkipped: pdf.numPages - images.length });
      }
    } else if (IMAGE.test(name)) {
      status("Claude is reading the image…");
      return extractWithClaude({ images: [file], source: "images", name, limits });
    } else throw new Error("That file type can't be read. Upload Excel, PDF, Word, CSV, text or an image (PNG/JPG).");
    const max = maxChars(limits);
    status("Claude is reading the document into the standard format…");
    return extractWithClaude({ text: text.slice(0, max), cells: N.textCells(text), truncated: text.length > max, source: "text", name, limits });
  }

  async function sampleLimits() { try { return cap.sample ? await withTimeout(cap.sample.limits(), 6000, "limits timed out") : null; } catch (_) { return null; } }
  const maxChars = (limits) => Math.max(20000, ((limits && limits.maxPromptBytes) || 262144) - 14000);

  /** Text of a PDF, one line per text row, with wide gaps shown as " | " so tables stay readable. */
  async function pdfToText(pdf) {
    let out = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 3) * 3;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str, h: Math.abs(it.transform[3]) || 8 });
      }
      out += `\n### Page ${p}\n`;
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const items = rows.get(y).sort((a, b) => a.x - b.x);
        let line = "", end = null;
        for (const it of items) {
          if (end !== null) line += it.x - end > it.h * 1.2 ? " | " : it.x - end > it.h * 0.15 ? " " : "";
          line += it.s; end = it.x + it.w;
        }
        out += line.trim() + "\n";
      }
    }
    return out;
  }

  async function pdfToImages(pdf, limits) {
    const max = Math.min(pdf.numPages, (limits && limits.images && limits.images.maxCount) || 8, 20);
    const blobs = [];
    for (let p = 1; p <= max; p++) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2.5, 1600 / base.width) });
      const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      blobs.push(await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85)));
    }
    return blobs;
  }

  async function extractWithClaude({ text, cells, images, truncated, source, name, limits, pagesSkipped }) {
    const N = window.SpecNormalize;
    if (!cap.sample) throw new Error("Claude isn't available in this view to read this file. Open the artifact on claude.ai and upload it there.");
    if (images && !(limits && limits.images)) throw new Error("This view can't send images to Claude. Open the artifact on claude.ai, or upload a PDF with selectable text, Excel or Word instead.");
    const tiers = limits && limits.modelTiers;
    const opts = { modelTier: !tiers || tiers.includes("complex") ? "complex" : "default" };
    if (images) opts.images = images;
    let raw;
    try { raw = await withTimeout(cap.sample.json(N.extractionPrompt(text || "", name, source), opts), 300000,
                                  "Claude didn't finish reading the file within 5 minutes. Try again, or upload a smaller file."); }
    catch (e) {
      if (e && e.code === "not_granted") throw new Error("Claude wasn't allowed to read the file. Allow it when asked, then upload again.");
      if (e && e.code === "rate_limited") throw new Error("Claude is busy right now. Try the upload again in a minute.");
      throw new Error("Claude couldn't read this file: " + (e.message || e.code));
    }
    const pre = [
      ...(truncated ? ["The file is very large, so only its first part was read."] : []),
      ...(pagesSkipped > 0 ? [`Only the first ${images.length} pages were read; ${pagesSkipped} more were left out.`] : []),
      ...(images ? ["Read from page images, so the values couldn't be checked against text. Compare them with the original before sending."] : []),
    ];
    const verify = (d) => (cells ? N.verifyAgainstWorkbook(d, cells) : []);
    if (raw && raw.kind === "engine") {
      const ed = N.cleanEngineData(raw.engine);
      return { spec: N.standardEngineSpec(ed, name), method: "claude", source, warnings: [...pre, ...ed.notes.map((n) => "Claude noted: " + n)], checks: verify(ed) };
    }
    const data = N.cleanData(raw && raw.aircraft ? raw.aircraft : raw);
    return { spec: N.standardSpec(data, name), method: "claude", source, warnings: [...pre, ...data.notes.map((n) => "Claude noted: " + n)], checks: verify(data) };
  }

  /** Write a new version and point the aircraft summary at it. expectVersion guards against overwriting someone else's save. */
  async function saveVersion(id, spec, source, note, expectVersion) {
    const sumRef = cap.db.doc("aircraft/" + id);
    const cur = await sumRef.get();
    const curV = cur.exists && !cur.data().archived ? cur.data().version || 0 : 0;
    if (expectVersion !== undefined && curV !== expectVersion) {
      const e = new Error("Someone saved a newer version while you were editing. Load it first, then make your change again."); e.conflict = true; throw e;
    }
    const n = curV + 1;
    spec.source = spec.source || {};
    await cap.db.doc(`aircraft/${id}/versions/${vid(n)}`).set({ n, created_at: nowIso(), by: me || "", source, note: note || "", spec });
    const findKv = (label) => { for (const s of spec.sections) if (s.type === "kv") for (const r of s.rows) if ((r.label || "").toUpperCase() === label) return r.value; return ""; };
    await sumRef.set({ kind: spec.cover.kind === "engine" ? "engine" : "aircraft", msn: String(spec.cover.msn || ""), model: spec.cover.model || "", registration: findKv("AIRCRAFT REGISTRATION"),
      info_date: findKv("INFORMATION DATE"), version: n, updated_at: nowIso(), updated_by: me || "", last_change: source, archived: false });
    return n;
  }

  // ------------------------------------------------------------ aircraft workspace
  async function openAircraft(id, force) {
    if (!force && ws && ws.id === id) return renderWorkspace();
    if (!cap.db) { $view.replaceChildren(h("div", { class: "panel empty" }, fleetError || h("span", { class: "spin" }), " Waiting for the spec sheet store…")); return; }
    $view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), " Opening spec sheet…"));
    const sum = await cap.db.doc("aircraft/" + id).get();
    if (!sum.exists || sum.data().archived) { $view.replaceChildren(h("div", { class: "panel empty" }, h("h2", {}, "Spec sheet not found"), h("p", {}, h("a", { href: "#fleet" }, "Back to the fleet")))); return; }
    const v = await cap.db.doc(`aircraft/${id}/versions/${vid(sum.data().version)}`).get();
    if (!v.exists) { $view.replaceChildren(h("div", { class: "panel empty" }, "This spec sheet's latest version couldn't be read. Try again in a moment.")); return; }
    const spec = clone(v.data().spec);
    ws = { id, version: sum.data().version, saved: clone(spec), spec, dirty: false, highlight: new Set(), lastAI: null, newer: null,
           showPreview: ws ? ws.showPreview : window.innerWidth > 700 };
    renderWorkspace();
    schedulePreview(0);
  }

  function checkNewerVersion() {
    const a = fleet.find((x) => x.id === ws.id);
    if (a && a.version > ws.version && a.updated_by !== me) { ws.newer = a; const b = document.getElementById("newer"); if (b) b.replaceWith(newerBanner()); }
  }
  function newerBanner() {
    if (!ws.newer) return h("div", { id: "newer", hidden: true });
    const el = h("div", { class: "banner", id: "newer" }, h("span", { class: "grow" }, `A newer version (v${ws.newer.version}, ${ws.newer.last_change}) was saved at ${when(ws.newer.updated_at)}.`),
      h("button", { class: "btn", onclick: async () => { if (!ws.dirty || await confirmDialog("Load the newer version?", "Your unsaved edits will be dropped.", "Load newer version", "danger")) { ws.dirty = false; openAircraft(ws.id, true); } } }, "Load it"));
    names([ws.newer.updated_by]).then((n) => { if (n[ws.newer.updated_by]) el.firstChild.textContent = `${n[ws.newer.updated_by]} saved a newer version (v${ws.newer.version}, ${ws.newer.last_change}) at ${when(ws.newer.updated_at)}.`; });
    return el;
  }

  function markDirty() {
    if (!ws) return;
    ws.dirty = true;
    const c = document.getElementById("state-chip"); if (c) { c.className = "pill on-dark warn"; c.textContent = "Unsaved"; }
    for (const id of ["save-btn", "discard-btn"]) { const b = document.getElementById(id); if (b) b.disabled = false; }
    schedulePreview();
    clearTimeout(checksTimer);
    checksTimer = setTimeout(() => { const el = document.getElementById("checks"); if (el && ws) el.replaceChildren(checksPanel(!canWrite)); }, 700);
  }
  let checksTimer = null;

  const runChecks = (spec) => window.SpecChecks.run(spec, { staleDays: settings.stale_days || 90 });

  /** Pre-send checks: data problems, recalculated figures, data age. */
  function checksPanel(ro) {
    const issues = runChecks(ws.spec);
    const n = (lvl) => issues.filter((i) => i.level === lvl).length;
    const fixable = issues.filter((i) => i.fix);
    const applyFixes = (list) => { for (const i of list) window.SpecChecks.applyFix(ws.spec, i.fix); renderWorkspace(); markDirty(); toast(`${list.length} figure${list.length > 1 ? "s" : ""} recalculated. Review, then Save.`); };
    const lvlChip = (l) => h("span", { class: `chip lvl-${l}` }, { error: "Fix", warn: "Check", info: "Note" }[l]);
    const details = h("details", { class: "checks-body" }, h("summary", {}, issues.length ? "Show checks" : "No problems found"),
      h("div", { class: "checks-list" }, issues.map((i) => h("div", { class: "check-row" }, lvlChip(i.level),
        h("span", { class: "small muted check-group" }, i.group), h("span", { class: "grow" }, i.text),
        i.fix && !ro ? h("button", { class: "btn", onclick: () => applyFixes([i]) }, "Use calculated value") : null))));
    if (n("error")) details.open = true;
    return h("div", { class: "panel pad checks" + (n("error") ? " has-errors" : "") },
      h("div", { class: "row" }, h("h2", { class: "grow" }, "Checks before sending"),
        n("error") ? h("span", { class: "chip lvl-error" }, `${n("error")} to fix`) : null,
        n("warn") ? h("span", { class: "chip lvl-warn" }, `${n("warn")} to check`) : null,
        !issues.length ? h("span", { class: "chip ok" }, "All clear") : null,
        fixable.length && !ro ? h("button", { class: "btn", onclick: () => applyFixes(fixable) }, `Recalculate all (${fixable.length})`) : null),
      h("p", { class: "small muted", style: "margin:4px 0 6px" }, "Derived figures (remaining, calendar consumed, next due, A/C age) are recalculated from the information date and compared with the sheet."),
      details);
  }

  const kvValue = (spec, label) => { for (const s of spec.sections) if (s.type === "kv") for (const r of s.rows) if ((r.label || "").toUpperCase() === label) return r.value; return ""; };

  function renderWorkspace() {
    const s = ws.spec; const c = s.cover;
    const reg = kvValue(s, "AIRCRAFT REGISTRATION");
    const ro = !canWrite;
    const isEng = c.kind === "engine";
    const issues = runChecks(s);
    const n = (lvl) => issues.filter((x) => x.level === lvl).length;
    const ageD = window.SpecChecks.dataAgeDays(kvValue(s, "INFORMATION DATE"));
    const toChecks = () => { const el = document.getElementById("checks"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
    const side = glance("Before you send it", [
      { l: "To fix", s: "Excel errors, overdue items", v: String(n("error")), tone: n("error") ? "crit" : "good", onClick: toChecks },
      { l: "To check", s: "recalculated figures, empty fields", v: String(n("warn")), tone: n("warn") ? "warn" : "good", onClick: toChecks },
      { l: "Data age", s: kvValue(s, "INFORMATION DATE") || "no information date", v: ageD === null ? "–" : `${ageD} days`, tone: ageD !== null && ageD > (settings.stale_days || 90) ? "warn" : "good", onClick: toChecks },
      { l: "Version", s: s.source && s.source.filename ? (s.source.filename.length > 38 ? s.source.filename.slice(0, 36) + "…" : s.source.filename) : "", v: `v${ws.version}`, onClick: showHistory },
    ]);
    const discard = async () => {
      if (await confirmDialog("Discard changes?", "Your unsaved edits to this spec sheet will be dropped.", "Discard", "danger")) { ws.spec = clone(ws.saved); ws.dirty = false; ws.highlight.clear(); renderWorkspace(); schedulePreview(0); } };
    const head = coverEl({
      crumbs: [["Spec sheets", "#fleet"], `${isEng ? "ESN" : "MSN"} ${c.msn || "?"}`],
      title: `${isEng ? "ESN" : "MSN"} ${c.msn || "?"}`,
      badge: h("span", { id: "state-chip", class: ws.dirty ? "pill on-dark warn" : "pill on-dark" }, ws.dirty ? "Unsaved" : "Saved"),
      sub: [c.model, reg].filter(Boolean).join(" · "),
      lede: `Edit any value, ask Claude for a change, then run the checks and download the PDF. Nothing is saved until you press Save.${ro ? " You can view this spec sheet but not change it." : ""}`,
      actions: [
        ro ? null : h("button", { class: "btn light", id: "save-btn", disabled: !ws.dirty, onclick: () => save() }, "Save"),
        h("button", { class: ro ? "btn light" : "btn glass", onclick: downloadPdf }, "Download PDF"),
        ro ? null : h("button", { class: "btn glass", onclick: () => pickFile(ACCEPT, async (f) => {
          if (!ws.dirty || await confirmDialog("Replace unsaved edits?", "Uploading a file saves its data as a new version. Your unsaved edits will be dropped.", "Upload")) { ws.dirty = false; importExcel(f, ws.id); } }) }, "Update from file"),
        h("button", { class: "btn glass", onclick: showHistory }, "History"),
        ro ? null : h("button", { class: "btn glass", id: "discard-btn", disabled: !ws.dirty, onclick: discard }, "Discard"),
        ro ? null : h("button", { class: "btn glass", "aria-label": "More actions", onclick: moreActions }, "•••"),
      ].filter(Boolean),
      side, compact: true });

    const editor = h("div", { class: "editor" }, ro ? null : askBox(), h("div", { id: "checks" }, checksPanel(ro)), coverPanel(ro), s.sections.map((sec, i) => sectionPanel(sec, i, ro)), ro ? null : addBar(), attachmentsPanel(ro));
    const preview = h("div", { class: "preview" },
      h("div", { class: "bar" }, h("h2", {}, "PDF preview"), h("span", { id: "pv-state", class: "small muted" }), h("span", { class: "grow" }),
        h("button", { class: "btn ghost", onclick: () => { ws.showPreview = false; renderWorkspace(); } }, "Hide")),
      h("div", { class: "pages", id: "pages" }));
    $view.replaceChildren(head, h("div", { class: "shell", style: "padding-top:22px" }, newerBanner(),
      ws.showPreview ? null : h("p", {}, h("button", { class: "btn", onclick: () => { ws.showPreview = true; renderWorkspace(); schedulePreview(0); } }, "Show PDF preview")),
      h("div", { class: "ws" + (ws.showPreview ? "" : " nopreview") }, editor, preview)));
    if (ws.showPreview && lastPreview.canvases) document.getElementById("pages").replaceChildren(...lastPreview.canvases);
  }

  async function save() {
    try {
      const source = ws.lastAI ? `Edit + AI: ${ws.lastAI}`.slice(0, 180) : "Manual edit";
      const changes = C.diff(ws.saved, ws.spec);
      const n = await saveVersion(ws.id, clone(ws.spec), source, "", ws.version);
      ws.version = n; ws.saved = clone(ws.spec); ws.dirty = false; ws.highlight.clear(); ws.lastAI = null; ws.newer = null;
      toast(changes.length ? `Saved v${n}: ${changes.length} value${changes.length === 1 ? "" : "s"} changed` : `Saved v${n}`);
      renderWorkspace();
    } catch (e) {
      if (e.conflict) dialog("Newer version exists", h("p", {}, e.message), [{ label: "Keep editing" }]);
      else toast("Couldn't save: " + (e.message || e.code), true);
    }
  }

  function moreActions() {
    dialog("More actions", h("div", {},
      h("p", {}, "Remove this aircraft from the fleet list. Its versions stay in the store, and uploading its workbook again brings it back as a fresh spec sheet.")),
      [{ label: "Cancel" }, { label: `Remove MSN ${ws.spec.cover.msn}`, cls: "danger", run: async () => {
        await cap.db.doc("aircraft/" + ws.id).update({ archived: true, updated_at: nowIso() });
        ws = null; location.hash = "#fleet"; toast("Removed from the fleet list");
      } }]);
  }

  // ------------------------------------------------------------ ask Claude
  const AI_RULES = `You edit aircraft technical specification sheets for ACIA Aero Leasing.
You get the current spec sheet as JSON and a change request from the commercial team. Reply with the smallest set of JSON-Pointer (RFC 6901) operations that makes the change.

Structure:
- /cover: {model, msn, year} for the cover page.
- /sections/N: blocks of the PDF in print order. Types: heading {title}; kv {title, rows:[{label,value}]}; grid {title, label_header, groups:[{label,span}], columns:[...], rows:[{label, cells:[...]}]} where cells[i] belongs to columns[i]; list {title, items:[{text,bold}]}. Every section also has page_break_before and hidden booleans.
- /attachments/N: {title, hidden, ...} extra pages such as the LOPA.

Rules:
- Values are display strings. Match the formatting already used in the same row or column: thousands separators, decimals, units like "FHs" or "mths", dates like "26 May 2026".
- Change only what was asked. If a change implies another value shown in the sheet (for example a new CSN changes Remaining = Limit - CSN), update that too and say so in the summary.
- op is "replace", "add" (use "/-" to append to an array) or "remove". value_json is the new value encoded as JSON text (for example "\\"8,450.20\\"", or an object for a new row). Use "" for remove.
- If the request is unclear or refers to something that isn't in the sheet, return no ops and explain what is unclear in the summary.

Answer with JSON only: {"summary": "one or two sentences", "ops": [{"op": "...", "path": "...", "value_json": "..."}]}`;

  function askBox() {
    const ta = h("textarea", { class: "ta", id: "ask-input", rows: 2, placeholder: 'Describe a change, e.g. "LH engine TSN is now 8,450.20 and CSN 9,620" or "hide the Airframe SI (CY) row"' });
    const btn = h("button", { class: "btn primary", onclick: async () => {
      const instruction = ta.value.trim(); if (!instruction) return ta.focus();
      if (!cap.sample) return toast("Asking Claude isn't available in this view. Make the change in the editor below.", true);
      btn.disabled = true; btn.replaceChildren(h("span", { class: "spin" }), " Working…");
      try {
        const doc = { cover: ws.spec.cover, sections: ws.spec.sections, attachments: (ws.spec.attachments || []).map((a) => ({ title: a.title, hidden: a.hidden })) };
        const input = `${AI_RULES}\n\n<spec>\n${JSON.stringify(doc)}\n</spec>\n\n<request>\n${instruction}\n</request>`;
        const r = await cap.sample.json(input, { modelTier: "default" });
        if (!r || !Array.isArray(r.ops)) throw new Error("Claude's answer wasn't in the expected shape. Try rephrasing the request.");
        const proposed = C.applyOps(ws.spec, r.ops);
        // attachments were sent without asset ids; keep the real ones
        proposed.attachments = (proposed.attachments || []).map((a, i) => ({ ...(ws.spec.attachments[i] || {}), ...a }));
        const changes = C.diff(ws.spec, proposed);
        dialog("Proposed change", h("div", {}, h("p", {}, r.summary || ""), changesTable(changes)),
          changes.length ? [{ label: "Cancel" }, { label: "Apply, then review and save", cls: "primary", run: () => {
            ws.spec = proposed; ws.highlight = new Set(changes.map((x) => x.field)); ws.lastAI = instruction; ta.value = ""; renderWorkspace(); markDirty(); } }]
            : [{ label: "OK" }]);
      } catch (e) {
        const code = e && e.code;
        if (code === "not_granted") toast("Claude wasn't allowed to answer. Make the change in the editor below.", true);
        else if (code === "rate_limited") toast("Too many requests just now. Try again in a minute.", true);
        else toast(e.message || "Claude couldn't make that change.", true);
      } finally { btn.disabled = false; btn.textContent = "Ask Claude"; }
    } }, "Ask Claude");
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) btn.click(); });
    return h("div", { class: "panel pad ask" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("label", { for: "ask-input", class: "small muted" }, "Ask for a change"), ta), h("div", { style: "padding-top:20px" }, btn)),
      h("div", { class: "hint small muted" }, "You'll see every value Claude proposes to change before anything is applied. Nothing is saved until you press Save. Ctrl+Enter sends."));
  }

  // ------------------------------------------------------------ editor panels
  function bind(obj, key, attrs) {
    return h("input", { class: "cellin", ...(attrs || {}), value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
  }
  function coverPanel(ro) {
    const c = ws.spec.cover;
    const f = (label, key) => { const id = fid("cv"); return h("div", { class: "field" }, h("label", { for: id }, label), h("input", { class: "input", id, value: c[key] || "", disabled: ro, oninput: (e) => { c[key] = e.target.value; markDirty(); } })); };
    const detected = C.aircraftKey({ ...ws.spec, cover: { ...c, illustration: "auto" } });
    const label = (k) => (C.AIRCRAFT_TYPES.find((t) => t[0] === k) || [k, k])[1];
    const selId = fid("cv");
    const sel = h("select", { class: "input", id: selId, disabled: ro, onchange: (e) => { c.illustration = e.target.value; markDirty(); } },
      h("option", { value: "auto" }, detected ? `Automatic (${label(detected)})` : "Automatic (type not recognised)"),
      C.AIRCRAFT_TYPES.map(([k, l]) => h("option", { value: k }, l)),
      h("option", { value: "none" }, "No illustration"));
    sel.value = c.illustration || "auto";
    const engDetected = C.engineKey({ ...ws.spec, cover: { ...c, engine_illustration: "auto" } });
    const engLabel = (k) => (C.ENGINE_TYPES.find((t) => t[0] === k) || [k, k])[1];
    const engId = fid("cv");
    const engSel = h("select", { class: "input", id: engId, disabled: ro, onchange: (e) => { c.engine_illustration = e.target.value; markDirty(); } },
      h("option", { value: "auto" }, engDetected ? `Automatic (${engLabel(engDetected)})` : "Automatic (engine not recognised)"),
      C.ENGINE_TYPES.map(([k, l]) => h("option", { value: k }, l)),
      h("option", { value: "none" }, "No illustration"));
    engSel.value = c.engine_illustration || "auto";
    const isEngine = c.kind === "engine";
    const kindId = fid("cv");
    const kindSel = h("select", { class: "input", id: kindId, disabled: ro, onchange: (e) => { c.kind = e.target.value; markDirty(); renderWorkspace(); } },
      h("option", { value: "aircraft" }, "Aircraft"), h("option", { value: "engine" }, "Engine"));
    kindSel.value = isEngine ? "engine" : "aircraft";
    return h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Cover page"),
      h("div", { class: "grid3" }, f(isEngine ? "Engine model" : "Aircraft model", "model"), f(isEngine ? "ESN" : "Aircraft MSN", "msn"), isEngine ? h("div", {}) : f("Year of manufacture", "year")),
      h("div", { class: "grid2", style: "margin-top:12px" },
        h("div", { class: "field" }, h("label", { for: kindId }, "Spec sheet for"), kindSel),
        isEngine ? h("div", { class: "field" }, h("label", { for: engId }, "Engine illustration (cover)"), engSel)
                 : h("div", { class: "field" }, h("label", { for: selId }, "Aircraft illustration (cover)"), sel)));
  }
  const headingAbove = (i) => { for (let k = i; k >= 0; k--) if (ws.spec.sections[k].type === "heading") return ws.spec.sections[k].title; return ""; };

  function sectionPanel(s, i, ro) {
    const secs = ws.spec.sections;
    const structural = (fn) => () => { fn(); renderWorkspace(); markDirty(); };
    const kind = { heading: "Heading", kv: "Fields", grid: "Table", list: "Text" }[s.type] || s.type;
    const head = h("div", { class: "sec-head" }, h("span", { class: "kind" }, kind),
      h("input", { class: "t", value: s.title || "", placeholder: "(no title)", "aria-label": "Block title", disabled: ro, oninput: (e) => { s.title = e.target.value; markDirty(); } }),
      ro ? null : [
        h("label", { title: "Start this block on a new page" }, h("input", { type: "checkbox", checked: s.page_break_before, onchange: (e) => { s.page_break_before = e.target.checked; markDirty(); } }), "New page"),
        h("label", { title: "Leave this block out of the PDF" }, h("input", { type: "checkbox", checked: s.hidden, onchange: structural(() => { s.hidden = !s.hidden; }) }), "Hide"),
        h("button", { class: "btn ghost", "aria-label": "Move up", disabled: i === 0, onclick: structural(() => { [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; }) }, "↑"),
        h("button", { class: "btn ghost", "aria-label": "Move down", disabled: i === secs.length - 1, onclick: structural(() => { [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; }) }, "↓"),
        h("button", { class: "btn ghost", "aria-label": "Delete block", onclick: async () => { if (await confirmDialog("Delete this block?", `“${s.title || kind}” will be removed from the spec sheet.`, "Delete", "danger")) structural(() => secs.splice(i, 1))(); } }, "✕")]);
    const name = s.title || headingAbove(i) || "Section";
    const hl = (k) => (ws.highlight.has(k) ? " hl" : "");
    const x = (fn, label) => ro ? null : h("td", { class: "x" }, h("button", { class: "btn ghost", "aria-label": label, onclick: structural(fn) }, "✕"));
    let body = null;
    if (s.type === "kv") {
      body = h("div", { class: "sec-body" }, h("table", {}, h("tbody", {}, s.rows.map((r, ri) => h("tr", {},
        h("td", { class: "lbl", style: "width:42%" }, bind(r, "label", { disabled: ro, "aria-label": "Label" })),
        h("td", { class: hl(`${name} › ${r.label}`) }, bind(r, "value", { disabled: ro, "aria-label": r.label })),
        x(() => s.rows.splice(ri, 1), "Remove row"))))),
        ro ? null : h("div", { class: "add" }, h("button", { class: "btn", onclick: structural(() => s.rows.push({ label: "", value: "" })) }, "+ Row")));
    } else if (s.type === "grid") body = gridEditor(s, name, structural, hl, ro);
    else if (s.type === "list") {
      body = h("div", { class: "sec-body" }, h("table", {}, h("tbody", {}, s.items.map((it, ii) => h("tr", {},
        h("td", {}, bind(it, "text", { disabled: ro, style: it.bold ? "font-weight:600" : "", "aria-label": "Line" })),
        ro ? null : h("td", { style: "width:72px" }, h("label", { class: "small muted" }, h("input", { type: "checkbox", checked: it.bold, onchange: structural(() => { it.bold = !it.bold; }) }), " Bold")),
        x(() => s.items.splice(ii, 1), "Remove line"))))),
        ro ? null : h("div", { class: "add" }, h("button", { class: "btn", onclick: structural(() => s.items.push({ text: "", bold: false })) }, "+ Line")));
    }
    return h("section", { class: `panel sec ${s.type}${s.hidden ? " is-hidden" : ""}` }, head, body);
  }

  function gridEditor(s, name, structural, hl, ro) {
    s.groups = s.groups || [];
    const groupOf = []; s.groups.forEach((g) => { for (let k = 0; k < g.span; k++) groupOf.push(g.label); });
    const av = (s.title || "").toUpperCase().includes("AVIONIC");
    const head = [];
    if (s.groups.length) head.push(h("tr", {}, h("th", {}), s.groups.map((g) => h("th", { colspan: g.span }, bind(g, "label", { disabled: ro, "aria-label": "Group" }))), ro ? null : h("th", {})));
    head.push(h("tr", {}, h("th", {}, bind(s, "label_header", { disabled: ro, "aria-label": "Row label heading" })),
      s.columns.map((c, ci) => h("th", {}, h("div", { class: "row", style: "gap:0;flex-wrap:nowrap" },
        h("input", { class: "cellin", value: c, disabled: ro, "aria-label": "Column heading", oninput: (e) => { s.columns[ci] = e.target.value; markDirty(); } }),
        ro ? null : h("button", { class: "btn ghost", "aria-label": `Delete column ${c}`, onclick: async () => { if (await confirmDialog("Delete column?", `Column “${c}” and its values will be removed.`, "Delete", "danger")) structural(() => deleteColumn(s, ci))(); } }, "✕")))),
      ro ? null : h("th", {})));
    const rows = s.rows.map((r, ri) => {
      const key = av ? `${r.cells[0] || ""} (${r.label})` : r.label;
      return h("tr", {}, h("td", { class: "lbl" }, bind(r, "label", { disabled: ro, "aria-label": "Row label" })),
        r.cells.map((_, ci) => {
          const col = groupOf[ci] ? `${groupOf[ci]} ${s.columns[ci]}` : s.columns[ci];
          return h("td", { class: "c" + hl(`${name} › ${key} › ${col}`) },
            h("input", { class: "cellin", value: r.cells[ci], disabled: ro, "aria-label": `${r.label} ${col}`, oninput: (e) => { r.cells[ci] = e.target.value; markDirty(); } }));
        }),
        ro ? null : h("td", { class: "x" }, h("button", { class: "btn ghost", "aria-label": "Remove row", onclick: structural(() => s.rows.splice(ri, 1)) }, "✕")));
    });
    return h("div", { class: "sec-body" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows)),
      ro ? null : h("div", { class: "add" },
        h("button", { class: "btn", onclick: structural(() => s.rows.push({ label: "", cells: s.columns.map(() => "") })) }, "+ Row"),
        h("button", { class: "btn", onclick: structural(() => { s.columns.push(""); s.rows.forEach((r) => r.cells.push("")); if (s.groups.length) s.groups[s.groups.length - 1].span++; }) }, "+ Column")));
  }
  function deleteColumn(s, ci) {
    s.columns.splice(ci, 1); s.rows.forEach((r) => r.cells.splice(ci, 1));
    let pos = 0; for (const g of s.groups) { if (ci < pos + g.span) { g.span--; break; } pos += g.span; }
    s.groups = s.groups.filter((g) => g.span > 0);
  }
  function addBar() {
    const add = (sec) => () => { ws.spec.sections.push({ id: C.newId(), page_break_before: false, hidden: false, ...sec }); renderWorkspace(); markDirty(); };
    return h("div", { class: "panel pad row" }, h("strong", {}, "Add a block"),
      h("button", { class: "btn", onclick: add({ type: "heading", title: "NEW HEADING" }) }, "+ Heading"),
      h("button", { class: "btn", onclick: add({ type: "kv", title: "", rows: [{ label: "", value: "" }] }) }, "+ Fields"),
      h("button", { class: "btn", onclick: add({ type: "grid", title: "", label_header: "", groups: [], columns: ["Column 1", "Column 2"], rows: [{ label: "", cells: ["", ""] }] }) }, "+ Table"),
      h("button", { class: "btn", onclick: add({ type: "list", title: "", items: [{ text: "", bold: false }] }) }, "+ Text"));
  }

  function attachmentsPanel(ro) {
    const atts = ws.spec.attachments || (ws.spec.attachments = []);
    const structural = (fn) => () => { fn(); renderWorkspace(); markDirty(); };
    return h("div", { class: "panel pad" },
      h("div", { class: "row" }, h("h2", { class: "grow" }, "Extra pages"),
        ro || !canAssets ? null : h("button", { class: "btn", onclick: () => pickFile("image/png,image/jpeg,application/pdf,.pdf", addPages) }, "+ Add image or PDF")),
      h("p", { class: "small muted", style: "margin:4px 0 8px" }, canAssets || ro
        ? "LOPA, emergency equipment layout, drawings. Each image gets its own page at the end; a PDF is added page by page."
        : "LOPA, emergency equipment layout, drawings. Only editors of this artifact can add images."),
      atts.length ? atts.map((a, i) => h("div", { class: "att" },
        h("img", { src: "/_blob/" + a.asset, alt: a.title || "Extra page" }),
        h("div", { class: "grow" }, bind(a, "title", { disabled: ro, placeholder: "Page title", "aria-label": "Page title" })),
        ro ? null : [
          h("label", { class: "small muted" }, h("input", { type: "checkbox", checked: a.hidden, onchange: structural(() => { a.hidden = !a.hidden; }) }), " Hide"),
          h("button", { class: "btn ghost", "aria-label": "Move up", disabled: i === 0, onclick: structural(() => { [atts[i - 1], atts[i]] = [atts[i], atts[i - 1]]; }) }, "↑"),
          h("button", { class: "btn ghost", "aria-label": "Move down", disabled: i === atts.length - 1, onclick: structural(() => { [atts[i + 1], atts[i]] = [atts[i], atts[i + 1]]; }) }, "↓"),
          h("button", { class: "btn ghost", "aria-label": "Remove page", onclick: structural(() => atts.splice(i, 1)) }, "✕")]))
        : h("p", { class: "muted" }, "None yet."));
  }

  async function addPages(file) {
    const done = busy(`Adding ${file.name}…`);
    try {
      const base = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const vp = page.getViewport({ scale: 2.2 });
          const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
          const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
          const up = await cap.assets.upload(blob);
          ws.spec.attachments.push({ id: C.newId(), title: pdf.numPages > 1 ? `${base} (${p}/${pdf.numPages})` : base, asset: up.id, origin: "upload", hidden: false });
        }
      } else {
        const up = await cap.assets.upload(file);
        ws.spec.attachments.push({ id: C.newId(), title: base, asset: up.id, origin: "upload", hidden: false });
      }
      done(); renderWorkspace(); markDirty();
    } catch (e) { done(); toast("Couldn't add that file: " + (e.message || e.code), true); }
  }

  // ------------------------------------------------------------ history
  async function showHistory() {
    const close = dialog("Version history", h("div", { id: "hist" }, h("span", { class: "spin" }), " Loading…"), [{ label: "Close" }]);
    try {
      const snap = await cap.db.collection(`aircraft/${ws.id}/versions`).orderBy("n", "desc").limit(200).get();
      const vs = snap.docs.map((d) => d.data());
      const who = await names(vs.map((v) => v.by));
      const box = document.getElementById("hist"); if (!box) return;
      box.replaceChildren(...vs.map((v, i) => h("div", { class: "hist" },
        h("span", { class: "when" }, when(v.created_at)), h("span", { class: "chip" }, `v${v.n}`),
        h("span", { class: "grow" }, v.source, v.note ? h("span", { class: "small muted" }, ` · ${v.note}`) : "", who[v.by] ? h("div", { class: "small muted" }, who[v.by]) : null),
        h("button", { class: "btn", onclick: () => dialog(`Version ${v.n}: changes`, h("div", {}, h("p", { class: "muted" }, `${v.source} · ${when(v.created_at)}`), changesTable(C.diff(vs[i + 1] ? vs[i + 1].spec : null, v.spec))), [{ label: "Close" }]) }, "Changes"),
        h("button", { class: "btn", onclick: () => downloadPdf(v.spec) }, "PDF"),
        v.n === ws.version ? h("span", { class: "chip ok" }, "Current") : canWrite ? h("button", { class: "btn", onclick: async () => {
          if (!(await confirmDialog(`Restore version ${v.n}?`, "It will be saved as a new version, so nothing is lost.", "Restore"))) return;
          try { await saveVersion(ws.id, clone(v.spec), `Restored v${v.n}`, "", ws.version); close(); ws.dirty = false; toast(`Restored v${v.n}`); openAircraft(ws.id, true); }
          catch (e) { toast(e.message, true); }
        } }, "Restore") : null)));
    } catch (e) { const box = document.getElementById("hist"); if (box) box.textContent = "Couldn't load the history: " + (e.message || e.code); }
  }

  // ------------------------------------------------------------ PDF build, preview, download
  const imageCache = new Map();
  async function assetDataUrl(id) {
    if (imageCache.has(id)) return imageCache.get(id);
    const p = (async () => {
      const res = await fetch("/_blob/" + id);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!/^image\/(png|jpe?g)$/.test(blob.type)) return null; // pdfmake embeds PNG and JPEG only
      return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
    })().catch(() => null);
    imageCache.set(id, p);
    return p;
  }

  const one = (f) => ({ normal: f, bold: f, italics: f, bolditalics: f });
  const FONTS = {
    Archivo: { normal: "Archivo-Regular.ttf", bold: "Archivo-Bold.ttf", italics: "Archivo-Italic.ttf", bolditalics: "Archivo-BoldItalic.ttf" },
    Heading: one("Archivo-SemiExpanded-SemiBold.ttf"), // headings: 600, wdth 112
    Feature: one("Archivo-Expanded-Bold.ttf"),         // feature names: 700, wdth 125
  };
  const FONT_SLOTS = [
    ["normal", "Regular", "400", "normal"], ["bold", "Bold (Medium or Semibold)", "600", "normal"],
    ["italics", "Italic", "400", "italic"], ["bolditalics", "Bold italic", "600", "italic"]];

  // Brand font files, fetched once per asset id.
  const fontCache = new Map();
  function fontBytes(id) {
    if (!fontCache.has(id)) fontCache.set(id, fetch("/_blob/" + id).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
    return fontCache.get(id);
  }
  function toBase64(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /** Fonts for pdfmake: the uploaded brand font when there is one, Archivo otherwise. Missing styles fall back sensibly. */
  async function pdfFonts() {
    const f = settings.font;
    if (!f || !f.normal) return { fonts: FONTS, vfs: A.fonts, name: "Archivo" };
    const vfs = { ...A.fonts }; const files = {};
    for (const [slot] of FONT_SLOTS) {
      if (!f[slot]) continue;
      const buf = await fontBytes(f[slot]);
      if (buf) { vfs[`Brand-${slot}`] = toBase64(buf); files[slot] = `Brand-${slot}`; }
    }
    if (!files.normal) return { fonts: FONTS, vfs: A.fonts, name: "Archivo" };
    const bold = files.bold || files.normal;
    return { fonts: { ...FONTS, Brand: { normal: files.normal, bold, italics: files.italics || files.normal, bolditalics: files.bolditalics || bold },
                      Heading: one(bold), Feature: one(bold) }, vfs, name: "Brand" };
  }
  /** Use the brand font for the app's own text too. */
  let uiFontKey = "";
  async function applyUiFont() {
    const f = settings.font;
    const key = f ? FONT_SLOTS.map(([k]) => f[k] || "").join("|") : "";
    if (key === uiFontKey) return;
    uiFontKey = key;
    const root = document.documentElement.style;
    if (!f || !f.normal) { root.removeProperty("--body"); root.removeProperty("--display"); return; }
    let any = false;
    for (const [slot, , weight, style] of FONT_SLOTS) {
      if (!f[slot]) continue;
      const buf = await fontBytes(f[slot]);
      if (!buf) continue;
      try { const face = new FontFace("ACIA Brand", buf, { weight, style }); await face.load(); document.fonts.add(face); any = true; } catch (_) {}
    }
    if (any) {
      root.setProperty("--body", '"ACIA Brand", "Archivo", system-ui, sans-serif');
      root.setProperty("--display", '"ACIA Brand", "Archivo", Arial, sans-serif');
    }
  }

  async function pageCount(bytes) {
    try { const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise; const n = doc.numPages; doc.destroy(); return n; }
    catch (_) { return 0; }
  }

  async function makePdf(spec) {
    const images = {};
    for (const a of spec.attachments || []) if (!a.hidden && a.asset) { const d = await assetDataUrl(a.asset); if (d) images[a.asset] = d; }
    const font = await pdfFonts();
    const key = C.aircraftKey(spec), eng = C.engineKey(spec);
    const assetsFor = { logoWhite: A.logoWhite, logoColor: A.logoColor, images, fontName: font.name,
                        aircraft: key ? A.aircraft[key] : null, engine: spec.cover.kind === "engine" && eng ? A.engines[eng] : null };
    const dd = C.buildPdf(spec, settings, assetsFor);
    const render = (def) => new Promise((res, rej) => {
      try { window.pdfMake.createPdf(def, null, font.fonts, font.vfs).getBuffer((buf) => res(new Uint8Array(buf))); } catch (e) { rej(e); }
    });
    let bytes = await render(dd);
    // Engine spec sheets are two pages: the cover plus one page. Tighten spacing (and drop empty fields) until it fits.
    if (spec.cover.kind === "engine") {
      for (let level = 1; level <= 4 && (await pageCount(bytes)) > 2; level++) {
        bytes = await render(C.buildPdf(spec, settings, { ...assetsFor, compact: level }));
      }
    }
    return bytes;
  }

  const pdfName = (spec) => `MSN ${spec.cover.msn || ""} Spec - ${new Date().toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}.pdf`.replace(/[^\w .\-]/g, "");
  async function downloadPdf(spec, opts) {
    spec = spec && spec.sections ? spec : ws.spec;
    if (!cap.downloads) return toast("Downloads aren't available in this view. Open the artifact on claude.ai to download the PDF.", true);
    if (!opts || !opts.skipChecks) {
      const issues = runChecks(spec).filter((i) => i.level !== "info");
      if (issues.length) {
        const errors = issues.filter((i) => i.level === "error").length;
        dialog("Before you send this", h("div", {},
          h("p", {}, errors ? `${errors} problem${errors > 1 ? "s" : ""} and ${issues.length - errors} thing${issues.length - errors === 1 ? "" : "s"} to check on this spec sheet:` : `${issues.length} thing${issues.length > 1 ? "s" : ""} to check on this spec sheet:`),
          h("div", { class: "changes-wrap" }, h("ul", { class: "small" }, issues.slice(0, 15).map((i) => h("li", {}, i.text)))),
          issues.length > 15 ? h("p", { class: "small muted" }, `…and ${issues.length - 15} more in Checks before sending.`) : null),
          [{ label: "Review first" }, { label: "Download anyway", cls: "primary", run: () => { downloadPdf(spec, { skipChecks: true }); } }]);
        return;
      }
    }
    if (ws && spec === ws.spec && ws.dirty) toast("This PDF includes your unsaved edits. Save them so the fleet list matches.");
    const done = busy("Building PDF…");
    try {
      const bytes = await makePdf(spec);
      done();
      await cap.downloads.save({ filename: pdfName(spec), data: new Blob([bytes], { type: "application/pdf" }) });
    } catch (e) { done(); if (e && e.code !== "cancelled" && e.code !== "declined") toast("Couldn't download the PDF: " + (e.message || e.code), true); }
  }

  let pvTimer = null, pvSeq = 0; const lastPreview = { canvases: null };
  function schedulePreview(delay) {
    if (!ws || !ws.showPreview) return;
    clearTimeout(pvTimer);
    pvTimer = setTimeout(renderPreview, delay === undefined ? 900 : delay);
  }
  async function renderPreview() {
    if (!ws || !ws.showPreview) return;
    const seq = ++pvSeq;
    const st = () => document.getElementById("pv-state");
    if (st()) st().replaceChildren(h("span", { class: "spin" }), " updating");
    try {
      const bytes = await makePdf(ws.spec);
      const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const canvases = [];
      const box = document.getElementById("pages");
      const width = Math.min(640, (box ? box.clientWidth : 500) - 28);
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * Math.min(2, window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale });
        const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        cv.setAttribute("aria-label", `Page ${p}`);
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        canvases.push(cv);
        if (seq !== pvSeq) return;
      }
      lastPreview.canvases = canvases;
      const b = document.getElementById("pages"); if (b) b.replaceChildren(...canvases);
      if (st()) st().textContent = `${pdf.numPages} pages${ws.dirty ? " · includes unsaved edits" : ""}`;
    } catch (e) { if (st()) st().textContent = "preview failed: " + (e.message || e); }
  }

  // ------------------------------------------------------------ settings
  function renderSettings() {
    const s = clone(settings);
    const ro = !canWrite || !cap.db;
    const f = (label, key, area) => { const id = fid("st"); return h("div", { class: "field" }, h("label", { for: id }, label),
      area ? h("textarea", { class: "ta", id, rows: 6, disabled: ro, oninput: (e) => (s[key] = e.target.value) }, s[key] || "")
           : h("input", { class: "input", id, value: s[key] || "", disabled: ro, oninput: (e) => (s[key] = e.target.value) })); };
    const box = h("div", {});
    const draw = () => box.replaceChildren(...s.contacts.map((c, i) => h("div", { class: "contact" },
      ...["name", "title", "email", "phone"].map((k) => h("input", { class: "input", value: c[k] || "", disabled: ro, "aria-label": k, placeholder: { name: "Name", title: "Job title", email: "Email", phone: "Phone" }[k], oninput: (e) => (c[k] = e.target.value) })),
      ro ? h("span", {}) : h("div", { class: "row", style: "gap:2px;flex-wrap:nowrap" },
        h("button", { class: "btn ghost", "aria-label": "Move up", disabled: i === 0, onclick: () => { [s.contacts[i - 1], s.contacts[i]] = [s.contacts[i], s.contacts[i - 1]]; draw(); } }, "↑"),
        h("button", { class: "btn ghost", "aria-label": "Remove contact", onclick: () => { s.contacts.splice(i, 1); draw(); } }, "✕")))),
      ro ? "" : h("button", { class: "btn", onclick: () => { s.contacts.push({ name: "", title: "", email: "", phone: "" }); draw(); } }, "+ Contact"));
    s.contacts = s.contacts || []; draw();
    const saveBtn = ro ? null : h("button", { class: "btn light", onclick: async () => {
      try { await cap.db.doc("config/settings").set(s); toast("Settings saved. Every PDF uses them from now on."); } catch (e) { toast("Couldn't save settings: " + (e.message || e.code), true); } } }, "Save settings");
    $view.replaceChildren(coverEl({ crumbs: [["Spec sheets", "#fleet"], "Settings"], title: "Settings",
        lede: "The cover contacts, disclaimer, header and footer used on every spec sheet PDF, and when data counts as out of date.",
        actions: [saveBtn, h("button", { class: "btn glass", onclick: () => (location.hash = "#fleet") }, "Back to spec sheets")].filter(Boolean), compact: true }),
      h("div", { class: "shell editor", style: "padding-top:22px" },
        h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Header and footer"),
          h("div", { class: "grid2" }, f("Company name", "company"), f("Document title", "doc_title"), f("Confidentiality line", "confidential"), f("Contacts heading on the cover", "contacts_heading"),
            (() => { const id = fid("st"); return h("div", { class: "field" }, h("label", { for: id }, "Flag data older than (days)"),
              h("input", { class: "input", id, type: "number", min: "1", value: s.stale_days || 90, disabled: ro, oninput: (e) => (s.stale_days = Math.max(1, parseInt(e.target.value, 10) || 90)) })); })())),
        h("div", { class: "panel pad" }, h("h2", {}, "Cover contacts"), h("p", { class: "small muted" }, "The first contact sits on its own line; the rest go two per row."), box),
        h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Cover disclaimer"), f("Disclaimer text", "disclaimer", true)),
        ro ? h("p", { class: "muted" }, "You can view these settings but not change them.") : h("div", {}, h("button", { class: "btn primary", onclick: async () => {
          try { await cap.db.doc("config/settings").set(s); toast("Settings saved. Every PDF uses them from now on."); } catch (e) { toast("Couldn't save settings: " + (e.message || e.code), true); }
        } }, "Save settings"))));
  }

  boot();
})();
