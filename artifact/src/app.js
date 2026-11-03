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
  function busy(msg) { const el = h("div", {}, h("span", { class: "spin" }), " ", msg); document.getElementById("toasts").append(el); return () => el.remove(); }

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
    return h("div", { class: "warn" }, h("strong", {}, `Check ${w.length} item${w.length > 1 ? "s" : ""} in the Excel file before sending this out:`),
      h("ul", {}, w.slice(0, 30).map((x) => h("li", {}, x))), w.length > 30 ? h("div", {}, `…and ${w.length - 30} more`) : null);
  }
  function pickFile(accept, cb) {
    const inp = h("input", { type: "file", accept, style: "position:fixed;left:-999px", onchange: () => { const f = inp.files[0]; inp.remove(); if (f) cb(f); } });
    document.body.append(inp); inp.click();
  }

  // ------------------------------------------------------------ platform capabilities
  const cap = { db: null, user: null, assets: null, downloads: null, sample: null };
  let me = null, canWrite = true, canAssets = false;
  const DEFAULT_SETTINGS = {
    company: "ACIA Aero Leasing", doc_title: "Specifications & Summary of Terms", confidential: "STRICTLY PRIVATE AND CONFIDENTIAL",
    contacts_heading: "For Additional Summary, Please Contact:", contacts: [], disclaimer: "",
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
    const drop = h("div", { class: "drop" },
      h("div", { class: "glyph", "aria-hidden": "true" }, "XLSX"),
      h("div", { class: "grow" }, h("strong", {}, "Drop a tech spec workbook here"),
        h("div", { class: "small muted" }, "A new MSN creates a spec sheet. An MSN already in the fleet gets a new version, and you'll see every value that changed.")),
      h("button", { class: "btn primary", disabled: !cap.db || !canWrite, onclick: () => pickFile(".xlsx,.xlsm", (f) => importExcel(f)) }, "Upload Excel"));
    if (cap.db && canWrite) {
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) importExcel(f); });
    }
    let list;
    if (!fleetLoaded && !fleetError) list = h("div", { class: "panel empty" }, h("span", { class: "spin" }), " Loading spec sheets…");
    else if (fleetError && !fleet.length) list = h("div", { class: "panel empty" }, fleetError);
    else if (!fleet.length) list = h("div", { class: "panel empty" }, h("h2", {}, "No spec sheets yet"), h("p", {}, "Upload the Excel tech spec for an aircraft to create its first spec sheet."));
    else list = h("div", { class: "fleet" }, fleet.map((a) => h("button", { class: "tail", onclick: () => (location.hash = "#ac-" + a.id) },
      h("div", { class: "top" }, h("span", { class: "msn feature-name" }, a.msn), h("span", { class: "model" }, a.model || ""), a.registration ? h("span", { class: "reg" }, a.registration) : null),
      h("dl", {},
        h("dt", {}, "Info date"), h("dd", {}, a.info_date || "–"),
        h("dt", {}, "Version"), h("dd", {}, `v${a.version || 1}`),
        h("dt", {}, "Updated"), h("dd", {}, when(a.updated_at)),
        h("dt", {}, "Last change"), h("dd", {}, a.last_change || "")))));
    $view.replaceChildren(
      h("div", { class: "fleet-head" }, h("div", { class: "grow" }, h("h1", {}, "Fleet spec sheets"),
        h("div", { class: "muted" }, `${fleet.length} aircraft · PDF in the ACIA layout, generated from the latest saved version`)),
        !canWrite ? h("span", { class: "chip" }, "View only") : null),
      drop, list);
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
    const done = busy(`Reading ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const { spec, warnings } = C.importWorkbook(buf, file.name);
      const msn = spec.cover.msn;
      if (!msn) throw new Error("No AIRCRAFT SERIAL NUMBER found in this workbook. Check it is the tech spec template.");
      const id = intoId || aid(msn);
      const sumRef = cap.db.doc("aircraft/" + id);
      const sum = await sumRef.get();
      const prev = sum.exists && !sum.data().archived ? await cap.db.doc(`aircraft/${id}/versions/${vid(sum.data().version)}`).get() : null;
      const prevSpec = prev && prev.exists ? prev.data().spec : null;
      if (intoId && prevSpec && prevSpec.cover.msn && String(prevSpec.cover.msn) !== String(msn)) warnings.unshift(`This workbook is for MSN ${msn}, but you uploaded it to MSN ${prevSpec.cover.msn}.`);

      // Images in the workbook body (LOPA) become extra pages; identical images are reused, not re-uploaded.
      const imgs = await C.workbookImages(buf).catch(() => []);
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
      dialog(prevSpec ? `MSN ${msn} updated` : `MSN ${msn} added`,
        h("div", {}, h("p", {}, prevSpec ? `Saved as a new version. ${changes.length} value${changes.length === 1 ? "" : "s"} changed since the previous version.` : "A new spec sheet was created from the workbook."),
          warningsBox(warnings), prevSpec ? changesTable(changes) : null),
        [{ label: "Open spec sheet", cls: "primary", run: () => { if (ws && ws.id === id) openAircraft(id, true); else location.hash = "#ac-" + id; } }]);
    } catch (e) { done(); toast(e.message || String(e), true); }
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
    await sumRef.set({ msn: String(spec.cover.msn || ""), model: spec.cover.model || "", registration: findKv("AIRCRAFT REGISTRATION"),
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
    const c = document.getElementById("state-chip"); if (c) { c.className = "chip dirty"; c.textContent = "Unsaved"; }
    for (const id of ["save-btn", "discard-btn"]) { const b = document.getElementById(id); if (b) b.disabled = false; }
    schedulePreview();
  }

  const kvValue = (spec, label) => { for (const s of spec.sections) if (s.type === "kv") for (const r of s.rows) if ((r.label || "").toUpperCase() === label) return r.value; return ""; };

  function renderWorkspace() {
    const s = ws.spec; const c = s.cover;
    const reg = kvValue(s, "AIRCRAFT REGISTRATION");
    const ro = !canWrite;
    const head = h("div", { class: "ws-head" },
      h("div", { class: "title" }, h("h1", {}, h("span", { class: "feature-name", style: "color:inherit;font-size:inherit" }, `MSN ${c.msn || "?"}`), " ", h("span", {}, `${c.model || ""}${reg ? " · " + reg : ""}`)),
        h("div", { class: "row small muted" }, `Version ${ws.version}`, s.source && s.source.filename ? ` · from ${s.source.filename}` : "",
          h("span", { id: "state-chip", class: ws.dirty ? "chip dirty" : "chip ok" }, ws.dirty ? "Unsaved" : "Saved"))),
      ro ? h("span", { class: "chip" }, "View only") : null,
      ro ? null : h("button", { class: "btn primary", id: "save-btn", disabled: !ws.dirty, onclick: () => save() }, "Save"),
      ro ? null : h("button", { class: "btn", id: "discard-btn", disabled: !ws.dirty, onclick: async () => {
        if (await confirmDialog("Discard changes?", "Your unsaved edits to this spec sheet will be dropped.", "Discard", "danger")) { ws.spec = clone(ws.saved); ws.dirty = false; ws.highlight.clear(); renderWorkspace(); schedulePreview(0); } } }, "Discard"),
      ro ? null : h("button", { class: "btn", onclick: () => pickFile(".xlsx,.xlsm", async (f) => {
        if (!ws.dirty || await confirmDialog("Replace unsaved edits?", "Uploading a workbook saves its data as a new version. Your unsaved edits will be dropped.", "Upload")) { ws.dirty = false; importExcel(f, ws.id); } }) }, "Update from Excel"),
      h("button", { class: "btn", onclick: showHistory }, "History"),
      h("button", { class: "btn sky", onclick: downloadPdf }, "Download PDF"),
      ro ? null : h("button", { class: "btn ghost", "aria-label": "More actions", onclick: moreActions }, "•••"));

    const editor = h("div", { class: "editor" }, ro ? null : askBox(), coverPanel(ro), s.sections.map((sec, i) => sectionPanel(sec, i, ro)), ro ? null : addBar(), attachmentsPanel(ro));
    const preview = h("div", { class: "preview" },
      h("div", { class: "bar" }, h("h2", {}, "PDF preview"), h("span", { id: "pv-state", class: "small muted" }), h("span", { class: "grow" }),
        h("button", { class: "btn ghost", onclick: () => { ws.showPreview = false; renderWorkspace(); } }, "Hide")),
      h("div", { class: "pages", id: "pages" }));
    $view.replaceChildren(...[head, newerBanner(),
      ws.showPreview ? null : h("p", {}, h("button", { class: "btn", onclick: () => { ws.showPreview = true; renderWorkspace(); schedulePreview(0); } }, "Show PDF preview")),
      h("div", { class: "ws" + (ws.showPreview ? "" : " nopreview") }, editor, preview)].filter(Boolean));
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
    return h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Cover page"),
      h("div", { class: "grid3" }, f("Aircraft model", "model"), f("Aircraft MSN", "msn"), f("Year of manufacture", "year")),
      h("div", { class: "grid2", style: "margin-top:12px" },
        h("div", { class: "field" }, h("label", { for: selId }, "Aircraft illustration (cover)"), sel),
        h("div", { class: "field" }, h("label", { for: engId }, "Engine illustration (Engines page)"), engSel)));
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

  async function makePdf(spec) {
    const images = {};
    for (const a of spec.attachments || []) if (!a.hidden && a.asset) { const d = await assetDataUrl(a.asset); if (d) images[a.asset] = d; }
    const font = await pdfFonts();
    const key = C.aircraftKey(spec), eng = C.engineKey(spec);
    const dd = C.buildPdf(spec, settings, { logoWhite: A.logoWhite, logoColor: A.logoColor, images, fontName: font.name,
                                            aircraft: key ? A.aircraft[key] : null, engine: eng ? A.engines[eng] : null });
    return await new Promise((res, rej) => {
      try { window.pdfMake.createPdf(dd, null, font.fonts, font.vfs).getBuffer((buf) => res(new Uint8Array(buf))); } catch (e) { rej(e); }
    });
  }

  const pdfName = (spec) => `MSN ${spec.cover.msn || ""} Spec - ${new Date().toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}.pdf`.replace(/[^\w .\-]/g, "");
  async function downloadPdf(spec) {
    spec = spec && spec.sections ? spec : ws.spec;
    if (ws && spec === ws.spec && ws.dirty) toast("This PDF includes your unsaved edits. Save them so the fleet list matches.");
    if (!cap.downloads) return toast("Downloads aren't available in this view. Open the artifact on claude.ai to download the PDF.", true);
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
  function fontPanel(s, ro) {
    const box = h("div", {});
    const draw = () => {
      const f = s.font || {};
      box.replaceChildren(
        h("p", { class: "small muted", style: "margin:4px 0 10px" },
          "The ACIA website uses Canada Type Gibson. Upload the Gibson font files your licence covers (.otf, .ttf or .woff) and the PDFs and this app will use them. ",
          "Until a Regular file is uploaded, PDFs and the app use Archivo. A missing style falls back to the closest one you uploaded."),
        h("div", { class: "grid2" }, FONT_SLOTS.map(([slot, label]) => h("div", { class: "field" }, h("label", {}, label),
          h("div", { class: "row", style: "flex-wrap:nowrap" },
            h("span", { class: f[slot] ? "chip ok" : "chip" }, f[slot] ? "Uploaded" : "Not set"),
            h("span", { class: "grow small muted mono", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, (f.names && f.names[slot]) || ""),
            ro || !canAssets ? null : h("button", { class: "btn", onclick: () => pickFile(".otf,.ttf,.woff,font/otf,font/ttf,font/woff", async (file) => {
              const done = busy(`Checking ${file.name}…`);
              try {
                const buf = await file.arrayBuffer();
                try { await new FontFace("probe", buf).load(); } catch (_) { throw new Error(`${file.name} isn't a font file this browser can read.`); }
                const up = await cap.assets.upload(new Blob([buf], { type: file.type || "font/otf" }));
                s.font = { family: "Gibson", ...(s.font || {}), [slot]: up.id, names: { ...((s.font && s.font.names) || {}), [slot]: file.name } };
                done(); draw(); toast(`${label} added. Press Save settings to use it.`);
              } catch (e) { done(); toast(e.message || "Couldn't upload that font.", true); }
            }) }, f[slot] ? "Replace" : "Upload"),
            ro || !f[slot] ? null : h("button", { class: "btn ghost", "aria-label": `Remove ${label}`, onclick: () => {
              const next = { ...s.font }; delete next[slot]; next.names = { ...(next.names || {}) }; delete next.names[slot];
              s.font = FONT_SLOTS.some(([k]) => next[k]) ? next : null; draw(); } }, "✕"))))),
        !canAssets && !ro ? h("p", { class: "small muted" }, "Only editors of this artifact can upload font files.") : "");
    };
    draw();
    return h("div", { class: "panel pad" }, h("h2", {}, "Brand font"), box);
  }

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
    $view.replaceChildren(h("div", { class: "fleet-head" }, h("div", { class: "grow" }, h("h1", {}, "Settings"), h("div", { class: "muted" }, "Used on every spec sheet PDF."))),
      h("div", { class: "editor" },
        h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Header and footer"),
          h("div", { class: "grid2" }, f("Company name", "company"), f("Document title", "doc_title"), f("Confidentiality line", "confidential"), f("Contacts heading on the cover", "contacts_heading"))),
        h("div", { class: "panel pad" }, h("h2", {}, "Cover contacts"), h("p", { class: "small muted" }, "The first contact sits on its own line; the rest go two per row."), box),
        h("div", { class: "panel pad" }, h("h2", { style: "margin-bottom:10px" }, "Cover disclaimer"), f("Disclaimer text", "disclaimer", true)),
        fontPanel(s, ro),
        ro ? h("p", { class: "muted" }, "You can view these settings but not change them.") : h("div", {}, h("button", { class: "btn primary", onclick: async () => {
          try { await cap.db.doc("config/settings").set(s); toast("Settings saved. Every PDF uses them from now on."); } catch (e) { toast("Couldn't save settings: " + (e.message || e.code), true); }
        } }, "Save settings"))));
  }

  boot();
})();
