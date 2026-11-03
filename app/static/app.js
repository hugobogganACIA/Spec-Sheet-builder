/* Spec Sheet Builder - front end (no build step, plain JS). */
"use strict";

// ------------------------------------------------------------------ helpers
const $view = document.getElementById("view");
const $modalRoot = document.getElementById("modal-root");

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.blob();
}

function toast(msg, err = false) {
  const el = h("div", { class: err ? "err" : "" }, msg);
  document.getElementById("toast").append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3000);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " +
         d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(16).slice(2, 10);

function modal(title, body, actions = []) {
  const close = () => bg.remove();
  const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) close(); } },
    h("div", { class: "modal" }, h("h2", {}, title), body,
      h("div", { class: "actions" }, actions.map((a) =>
        h("button", { class: a.class || "", onclick: async (e) => {
          if (a.onClick) { e.target.disabled = true; try { if ((await a.onClick()) !== false) close(); } finally { e.target.disabled = false; } }
          else close();
        } }, a.label)))));
  $modalRoot.append(bg);
  return close;
}

function changesTable(changes, limit = 400) {
  if (!changes.length) return h("p", { class: "muted" }, "No values changed.");
  return h("div", { class: "scroll" }, h("table", { class: "changes" },
    h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Was"), h("th", {}, "Now"))),
    h("tbody", {}, changes.slice(0, limit).map((c) =>
      h("tr", {}, h("td", {}, c.field), h("td", { class: "old" }, c.old), h("td", { class: "new" }, c.new))))),
    changes.length > limit ? h("p", { class: "muted small" }, `…and ${changes.length - limit} more`) : null);
}

function warningsBox(warnings) {
  if (!warnings || !warnings.length) return null;
  return h("div", { class: "warn" }, h("strong", {}, `Please check ${warnings.length} item(s) from the Excel file:`),
    h("ul", {}, warnings.slice(0, 30).map((w) => h("li", {}, w))));
}

function pickFile(accept, cb) {
  const input = h("input", { type: "file", accept, style: "display:none", onchange: () => { if (input.files[0]) cb(input.files[0]); input.remove(); } });
  document.body.append(input);
  input.click();
}

// ------------------------------------------------------------------ routing
let config = { ai_enabled: false };
let ws = null; // current aircraft workspace state

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (ws && ws.dirty) { e.preventDefault(); e.returnValue = ""; } });

async function route() {
  if (ws && ws.dirty && !location.hash.startsWith(`#/aircraft/${ws.id}`)) {
    if (!confirm("You have unsaved changes. Leave without saving?")) { location.hash = `#/aircraft/${ws.id}`; return; }
  }
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/aircraft\/([\w]+)/);
  if (m) return showAircraft(m[1]);
  ws = null;
  if (hash.startsWith("#/settings")) return showSettings();
  return showFleet();
}

// ------------------------------------------------------------------ fleet
async function uploadExcel(file, aircraftId) {
  const fd = new FormData();
  fd.append("file", file);
  const busy = toastBusy(`Importing ${file.name}…`);
  try {
    const url = aircraftId ? `/api/aircraft/${aircraftId}/import` : "/api/import";
    const r = await api("POST", url, fd, true);
    busy();
    const body = h("div", {},
      h("p", {}, r.created ? "New aircraft created from the spreadsheet."
        : `New version saved. ${r.change_count} value(s) changed since the previous version.`),
      warningsBox(r.warnings),
      r.created ? null : changesTable(r.changes));
    modal(r.created ? "Spec sheet imported" : "Spec sheet updated", body, [{ label: "Open spec sheet", class: "primary" }]);
    if (ws && ws.id === r.aircraft_id) { ws.dirty = false; await showAircraft(r.aircraft_id, true); }
    else location.hash = `#/aircraft/${r.aircraft_id}`;
  } catch (e) { busy(); toast(e.message, true); }
}

function toastBusy(msg) {
  const el = h("div", {}, h("span", { class: "spinner" }), " ", msg);
  document.getElementById("toast").append(el);
  return () => el.remove();
}

async function showFleet() {
  $view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  const list = await api("GET", "/api/aircraft");
  const drop = h("div", { class: "drop" },
    h("strong", {}, "Drop an Excel tech spec here"), " or ",
    h("button", { class: "primary", onclick: () => pickFile(".xlsx,.xlsm", (f) => uploadExcel(f)) }, "Choose file"),
    h("div", { class: "small", style: "margin-top:8px" },
      "A new MSN creates a new spec sheet. An MSN that already exists is updated as a new version."));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) uploadExcel(e.dataTransfer.files[0]); });

  const table = list.length ? h("table", { class: "list" },
    h("thead", {}, h("tr", {}, ["MSN", "Model", "Registration", "Information date", "Last updated", "Last change", ""].map((t) => h("th", {}, t)))),
    h("tbody", {}, list.map((a) => h("tr", { class: "click", onclick: () => (location.hash = `#/aircraft/${a.id}`) },
      h("td", { class: "msn" }, a.msn), h("td", {}, a.model), h("td", {}, a.registration), h("td", {}, a.info_date),
      h("td", { class: "muted" }, fmtDate(a.updated_at)), h("td", { class: "muted" }, a.last_change),
      h("td", {}, h("a", { class: "btn", href: `/api/aircraft/${a.id}/pdf`, onclick: (e) => e.stopPropagation() }, "PDF"))))))
    : h("div", { class: "card empty" }, "No spec sheets yet. Upload an Excel tech spec to get started.");

  $view.replaceChildren(
    h("div", { class: "fleet-head" }, h("h1", {}, "Aircraft spec sheets"), h("span", { class: "badge" }, `${list.length} aircraft`)),
    drop, table);
}

// ------------------------------------------------------------------ aircraft workspace
async function showAircraft(id, force) {
  if (!force && ws && ws.id === id) return renderWorkspace();
  $view.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  const a = await api("GET", `/api/aircraft/${id}`);
  ws = { id, versionId: a.version_id, saved: a.spec, spec: clone(a.spec), versions: a.versions,
         dirty: false, highlight: new Set(), previewUrl: null, showPreview: ws?.showPreview ?? true };
  renderWorkspace();
  refreshPreview();
}

function markDirty() {
  ws.dirty = true;
  const b = document.getElementById("dirty-badge");
  if (b) { b.textContent = "Unsaved changes"; b.className = "badge dirty"; }
  const s = document.getElementById("save-btn");
  if (s) s.disabled = false;
  const d = document.getElementById("discard-btn");
  if (d) d.disabled = false;
}

function renderWorkspace() {
  const spec = ws.spec;
  const c = spec.cover || (spec.cover = {});
  const reg = findKv(spec, "AIRCRAFT REGISTRATION");
  const head = h("div", { class: "ws-head" },
    h("div", { class: "title" },
      h("h1", {}, `MSN ${c.msn || "?"}`, h("span", { class: "muted", style: "font-weight:400" }, `  ${c.model || ""}${reg ? " · " + reg : ""}`)),
      h("div", { class: "small muted" }, `Version ${ws.versionId} · source ${spec.source?.filename ? spec.source.filename.split("/").pop() : "manual"}`,
        " ", h("span", { id: "dirty-badge", class: ws.dirty ? "badge dirty" : "badge" }, ws.dirty ? "Unsaved changes" : "Saved"))),
    h("button", { id: "save-btn", class: "primary", disabled: !ws.dirty, onclick: () => save(ws.lastAI ? `Manual edit + AI: ${ws.lastAI}` : undefined) }, "Save"),
    h("button", { id: "discard-btn", disabled: !ws.dirty, onclick: () => { if (confirm("Discard unsaved changes?")) { ws.spec = clone(ws.saved); ws.dirty = false; ws.highlight.clear(); renderWorkspace(); refreshPreview(); } } }, "Discard"),
    h("button", { onclick: () => pickFile(".xlsx,.xlsm", (f) => { if (!ws.dirty || confirm("Uploading replaces your unsaved edits. Continue?")) uploadExcel(f, ws.id); }) }, "Update from Excel"),
    h("button", { onclick: showHistory }, `History (${ws.versions.length})`),
    h("a", { class: "btn sky", href: `/api/aircraft/${ws.id}/pdf`, style: "background:var(--sky);color:#fff;border-color:var(--sky)",
      onclick: (e) => { if (ws.dirty) { e.preventDefault(); toast("Save your changes first - the download uses the saved version.", true); } } }, "Download PDF"),
    h("button", { class: "icon", title: "More", onclick: moreMenu }, "⋯"));

  const editor = h("div", { class: "editor" }, aiBox(), coverCard(), spec.sections.map((s, i) => sectionCard(s, i)), addSectionBar(), attachmentsCard());
  const preview = h("div", { class: "preview" },
    h("div", { class: "bar" }, h("strong", {}, "PDF preview"), h("span", { id: "preview-state", class: "small muted" }),
      h("span", { class: "spacer" }),
      h("button", { onclick: refreshPreview }, "Refresh preview"),
      h("button", { class: "icon", onclick: () => { ws.showPreview = false; renderWorkspace(); } }, "Hide")),
    h("iframe", { id: "preview-frame", title: "PDF preview", src: ws.previewUrl || "about:blank" }));

  const showBtn = ws.showPreview ? null : h("button", { onclick: () => { ws.showPreview = true; renderWorkspace(); refreshPreview(); } }, "Show PDF preview");
  $view.replaceChildren(head, showBtn || "", h("div", { class: "ws" + (ws.showPreview ? "" : " hide-preview") }, editor, preview));
}

function moreMenu() {
  modal("More actions", h("div", {},
    h("p", {}, h("button", { class: "danger", onclick: async () => {
      if (!confirm(`Remove MSN ${ws.spec.cover.msn} from the fleet list? (Its history is kept in the database.)`)) return;
      await api("DELETE", `/api/aircraft/${ws.id}`);
      ws = null; document.querySelector(".modal-bg")?.remove(); location.hash = "#/";
    } }, "Remove this aircraft")),
    h("p", { class: "small muted" }, "Removing hides the aircraft from the list; uploading its Excel again starts a fresh record.")),
    [{ label: "Close" }]);
}

function findKv(spec, label) {
  for (const s of spec.sections) if (s.type === "kv") for (const r of s.rows) if ((r.label || "").toUpperCase() === label) return r.value;
  return "";
}

async function save(source, note) {
  try {
    const r = await api("PUT", `/api/aircraft/${ws.id}/spec`, { spec: ws.spec, base_version: ws.versionId, source, note });
    toast(r.changes.length ? `Saved - ${r.changes.length} value(s) changed` : "Saved");
    ws.dirty = false; ws.highlight.clear(); ws.lastAI = null;
    await showAircraft(ws.id, true);
  } catch (e) { toast(e.message, true); }
}

async function refreshPreview() {
  if (!ws || !ws.showPreview) return;
  const state = document.getElementById("preview-state");
  const frame = document.getElementById("preview-frame");
  if (state) state.replaceChildren(h("span", { class: "spinner dark" }), " rendering…");
  try {
    let url;
    if (ws.dirty) {
      const blob = await api("POST", `/api/aircraft/${ws.id}/preview`, { spec: ws.spec });
      url = URL.createObjectURL(blob);
    } else {
      url = `/api/aircraft/${ws.id}/pdf?inline=1&version=${ws.versionId}`;
    }
    if (ws.previewUrl && ws.previewUrl.startsWith("blob:")) URL.revokeObjectURL(ws.previewUrl);
    ws.previewUrl = url;
    const f = document.getElementById("preview-frame");
    if (f) f.src = url;
    const st = document.getElementById("preview-state");
    if (st) st.textContent = ws.dirty ? "showing unsaved changes" : "showing saved version";
  } catch (e) {
    if (state) state.textContent = "preview failed";
    toast("Preview failed: " + e.message, true);
  }
}

// ------------------------------------------------------------------ AI change box
function aiBox() {
  const ta = h("textarea", { placeholder: config.ai_enabled
    ? 'Describe a change, e.g. "LH engine TSN is now 8,450.20 and CSN 9,620" or "hide the Airframe SI (CY) row"'
    : "AI changes are switched off - set ANTHROPIC_API_KEY on the server to enable them.", disabled: !config.ai_enabled });
  const btn = h("button", { class: "primary", disabled: !config.ai_enabled, onclick: async () => {
    const instruction = ta.value.trim();
    if (!instruction) return;
    btn.disabled = true; btn.replaceChildren(h("span", { class: "spinner" }), " Working…");
    try {
      const r = await api("POST", `/api/aircraft/${ws.id}/ai-edit`, { instruction, spec: ws.spec });
      modal("Proposed change", h("div", {}, h("p", {}, r.summary), changesTable(r.changes)), [
        { label: "Cancel" },
        { label: "Apply (then review & save)", class: "primary", onClick: () => {
            if (!r.changes.length && !r.ops.length) return true;
            ws.spec = r.spec; ws.highlight = new Set(r.changes.map((c) => c.field)); markDirty(); ta.value = "";
            renderWorkspace(); refreshPreview(); ws.lastAI = instruction; } },
      ]);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = "Ask"; }
  } }, "Ask");
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) btn.click(); });
  return h("div", { class: "card ai" }, h("div", { class: "row", style: "align-items:flex-start" }, ta, btn),
    h("div", { class: "hint" }, "Ask in plain English. You will see every proposed value change before it is applied, and nothing is saved until you press Save. Ctrl+Enter to send."));
}

// ------------------------------------------------------------------ editor cards
function bindInput(obj, key, attrs = {}) {
  return h("input", { ...attrs, value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
}

function coverCard() {
  const c = ws.spec.cover;
  return h("div", { class: "card" }, h("h2", {}, "Cover page"),
    h("div", { class: "settings-grid", style: "grid-template-columns:1fr 1fr 1fr" },
      h("div", { class: "field" }, h("label", {}, "Aircraft model"), bindInput(c, "model")),
      h("div", { class: "field" }, h("label", {}, "Aircraft MSN"), bindInput(c, "msn")),
      h("div", { class: "field" }, h("label", {}, "Year of manufacture"), bindInput(c, "year"))));
}

function headingFor(index) {
  for (let i = index; i >= 0; i--) if (ws.spec.sections[i].type === "heading") return ws.spec.sections[i].title;
  return "";
}

function sectionCard(s, i) {
  const secs = ws.spec.sections;
  const structural = (fn) => () => { fn(); markDirty(); renderWorkspace(); };
  const kindLabel = { heading: "Heading", kv: "Fields", grid: "Table", list: "Text" }[s.type] || s.type;
  const head = h("div", { class: "sec-head" },
    h("span", { class: "kind" }, kindLabel),
    h("input", { class: "title", value: s.title || "", placeholder: s.type === "heading" ? "Heading" : "(no title)",
      oninput: (e) => { s.title = e.target.value; markDirty(); } }),
    h("label", { class: "check", title: "Start this block on a new page" },
      h("input", { type: "checkbox", checked: s.page_break_before, onchange: (e) => { s.page_break_before = e.target.checked; markDirty(); } }), "new page"),
    h("label", { class: "check", title: "Leave this block out of the PDF" },
      h("input", { type: "checkbox", checked: s.hidden, onchange: structural(() => { s.hidden = !s.hidden; }) }), "hide"),
    h("button", { class: "icon", title: "Move up", disabled: i === 0, onclick: structural(() => { [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; }) }, "▲"),
    h("button", { class: "icon", title: "Move down", disabled: i === secs.length - 1, onclick: structural(() => { [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; }) }, "▼"),
    h("button", { class: "icon danger", title: "Delete block", onclick: () => { if (confirm("Delete this block?")) structural(() => secs.splice(i, 1))(); } }, "✕"));

  let body = null;
  const name = s.title || headingFor(i) || "Section";
  const hl = (key) => (ws.highlight.has(key) ? "changed" : null);
  if (s.type === "kv") {
    body = h("div", { class: "sec-body" }, h("table", {}, h("tbody", {}, s.rows.map((r, ri) =>
      h("tr", {}, h("td", { class: "lbl", style: "width:42%" }, bindInput(r, "label")),
        h("td", { class: hl(`${name} › ${r.label}`) }, bindInput(r, "value")),
        h("td", { class: "x" }, h("button", { class: "icon", title: "Remove row", onclick: structural(() => s.rows.splice(ri, 1)) }, "✕")))))),
      h("div", { class: "addbar" }, h("button", { onclick: structural(() => s.rows.push({ label: "", value: "" })) }, "+ Row")));
  } else if (s.type === "grid") {
    body = gridEditor(s, name, structural, hl);
  } else if (s.type === "list") {
    body = h("div", { class: "sec-body" }, h("table", {}, h("tbody", {}, s.items.map((it, ii) =>
      h("tr", {}, h("td", {}, bindInput(it, "text", { style: it.bold ? "font-weight:700" : "" })),
        h("td", { style: "width:70px" }, h("label", { class: "check" }, h("input", { type: "checkbox", checked: it.bold, onchange: structural(() => { it.bold = !it.bold; }) }), "bold")),
        h("td", { class: "x" }, h("button", { class: "icon", onclick: structural(() => s.items.splice(ii, 1)) }, "✕")))))),
      h("div", { class: "addbar" }, h("button", { onclick: structural(() => s.items.push({ text: "", bold: false })) }, "+ Line")));
  }
  return h("div", { class: `card sec ${s.type}${s.hidden ? " is-hidden" : ""}` }, head, body);
}

function gridEditor(s, name, structural, hl) {
  s.groups = s.groups || [];
  const groupOf = [];
  s.groups.forEach((g) => { for (let k = 0; k < g.span; k++) groupOf.push(g.label); });
  const isAv = (s.title || "").toUpperCase().includes("AVIONIC");
  const rows = [];
  if (s.groups.length) {
    rows.push(h("tr", { class: "grp" }, h("th", {}), s.groups.map((g) =>
      h("th", { colspan: g.span }, bindInput(g, "label", { placeholder: "group" }))), h("th", {})));
  }
  rows.push(h("tr", {}, h("th", {}, bindInput(s, "label_header", { placeholder: "" })),
    s.columns.map((c, ci) => h("th", {}, h("div", { class: "row", style: "gap:2px" },
      h("input", { value: c, oninput: (e) => { s.columns[ci] = e.target.value; markDirty(); } }),
      h("button", { class: "icon", title: "Delete column", onclick: () => { if (confirm(`Delete column "${c}"?`)) structural(() => deleteColumn(s, ci))(); } }, "✕")))),
    h("th", {})));
  const body = s.rows.map((r, ri) => {
    const key = isAv ? `${r.cells[0] || ""} (${r.label})` : r.label;
    return h("tr", {}, h("td", { class: "lbl" }, bindInput(r, "label")),
      r.cells.map((_, ci) => {
        const col = groupOf[ci] ? `${groupOf[ci]} ${s.columns[ci]}` : s.columns[ci];
        return h("td", { class: "cell " + (hl(`${name} › ${key} › ${col}`) || "") },
          h("input", { value: r.cells[ci], oninput: (e) => { r.cells[ci] = e.target.value; markDirty(); } }));
      }),
      h("td", { class: "x" }, h("button", { class: "icon", title: "Remove row", onclick: structural(() => s.rows.splice(ri, 1)) }, "✕")));
  });
  return h("div", { class: "sec-body" }, h("table", {}, h("thead", {}, rows), h("tbody", {}, body)),
    h("div", { class: "addbar" },
      h("button", { onclick: structural(() => s.rows.push({ label: "", cells: s.columns.map(() => "") })) }, "+ Row"),
      h("button", { onclick: structural(() => { s.columns.push(""); s.rows.forEach((r) => r.cells.push("")); if (s.groups.length) s.groups[s.groups.length - 1].span++; }) }, "+ Column")));
}

function deleteColumn(s, ci) {
  s.columns.splice(ci, 1);
  s.rows.forEach((r) => r.cells.splice(ci, 1));
  let pos = 0;
  for (const g of s.groups) { if (ci < pos + g.span) { g.span--; break; } pos += g.span; }
  s.groups = s.groups.filter((g) => g.span > 0);
}

function addSectionBar() {
  const add = (sec) => () => { ws.spec.sections.push({ id: uid(), page_break_before: false, hidden: false, ...sec }); markDirty(); renderWorkspace(); };
  return h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, "Add a block:"),
    h("button", { onclick: add({ type: "heading", title: "NEW HEADING" }) }, "+ Heading"),
    h("button", { onclick: add({ type: "kv", title: "", rows: [{ label: "", value: "" }] }) }, "+ Fields"),
    h("button", { onclick: add({ type: "grid", title: "", label_header: "", groups: [], columns: ["Column 1", "Column 2"], rows: [{ label: "", cells: ["", ""] }] }) }, "+ Table"),
    h("button", { onclick: add({ type: "list", title: "", items: [{ text: "", bold: false }] }) }, "+ Text")));
}

function attachmentsCard() {
  const atts = ws.spec.attachments || (ws.spec.attachments = []);
  const structural = (fn) => () => { fn(); markDirty(); renderWorkspace(); };
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Extra pages (LOPA, layouts, drawings)"), h("span", { class: "spacer" }),
      h("button", { onclick: () => pickFile("image/*,.pdf", async (f) => {
        const fd = new FormData(); fd.append("file", f);
        try {
          const att = await api("POST", `/api/aircraft/${ws.id}/attachments`, fd, true);
          atts.push(att); markDirty(); renderWorkspace(); refreshPreview();
        } catch (e) { toast(e.message, true); }
      }) }, "+ Add image or PDF")),
    h("p", { class: "small muted", style: "margin:6px 0 8px" }, "Each image gets its own page at the end of the PDF; PDF files are added page by page."),
    atts.length ? atts.map((a, i) => h("div", { class: "attach-item" },
      a.kind === "image" ? h("img", { src: `/api/aircraft/${ws.id}/files/${a.file}`, alt: "" }) : h("span", { class: "badge" }, "PDF"),
      bindInput(a, "title", { placeholder: "Page title" }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: a.hidden, onchange: structural(() => { a.hidden = !a.hidden; }) }), "hide"),
      h("a", { class: "btn", href: `/api/aircraft/${ws.id}/files/${a.file}`, target: "_blank" }, "View"),
      h("button", { class: "icon", disabled: i === 0, onclick: structural(() => { [atts[i - 1], atts[i]] = [atts[i], atts[i - 1]]; }) }, "▲"),
      h("button", { class: "icon", disabled: i === atts.length - 1, onclick: structural(() => { [atts[i + 1], atts[i]] = [atts[i], atts[i + 1]]; }) }, "▼"),
      h("button", { class: "icon danger", onclick: () => { if (confirm("Remove this page?")) structural(() => atts.splice(i, 1))(); } }, "✕")))
      : h("p", { class: "muted" }, "None yet."));
}

// ------------------------------------------------------------------ history
async function showHistory() {
  const list = h("div", { class: "scroll" }, ws.versions.map((v) => h("div", { class: "history-item" },
    h("span", { class: "when" }, fmtDate(v.created_at)),
    h("span", { class: "badge" }, `v${v.id}`),
    h("span", { style: "flex:1" }, v.source, v.note ? h("span", { class: "muted small" }, ` - ${v.note.split("/").pop()}`) : ""),
    h("button", { onclick: () => showVersion(v) }, "Changes"),
    h("a", { class: "btn", href: `/api/aircraft/${ws.id}/pdf?version=${v.id}` }, "PDF"),
    v.id === ws.versionId ? h("span", { class: "badge" }, "current") :
      h("button", { onclick: async () => {
        if (!confirm(`Restore version ${v.id}? This saves it as a new version; nothing is lost.`)) return;
        await api("POST", `/api/aircraft/${ws.id}/versions/${v.id}/restore`);
        document.querySelector(".modal-bg")?.remove(); ws.dirty = false; toast("Version restored"); showAircraft(ws.id, true);
      } }, "Restore"))));
  modal("Version history", list, [{ label: "Close" }]);
}

async function showVersion(v) {
  const r = await api("GET", `/api/aircraft/${ws.id}/versions/${v.id}`);
  modal(`Version ${v.id} - ${v.source}`, h("div", {}, h("p", { class: "muted" }, fmtDate(v.created_at), v.note ? ` · ${v.note}` : ""),
    h("p", {}, "Changes compared with the version before it:"), changesTable(r.changes)), [{ label: "Close" }]);
}

// ------------------------------------------------------------------ settings
async function showSettings() {
  const s = await api("GET", "/api/settings");
  const field = (label, key, multiline) => h("div", { class: "field" }, h("label", {}, label),
    multiline ? h("textarea", { rows: 6, oninput: (e) => (s[key] = e.target.value) }, s[key]) : bindPlain(s, key));
  const contactsBox = h("div", {});
  const drawContacts = () => contactsBox.replaceChildren(
    ...s.contacts.map((c, i) => h("div", { class: "contact" },
      bindPlain(c, "name", "Name"), bindPlain(c, "title", "Job title"), bindPlain(c, "email", "Email"), bindPlain(c, "phone", "Phone"),
      h("div", { class: "row", style: "gap:2px" },
        h("button", { class: "icon", disabled: i === 0, onclick: () => { [s.contacts[i - 1], s.contacts[i]] = [s.contacts[i], s.contacts[i - 1]]; drawContacts(); } }, "▲"),
        h("button", { class: "icon danger", onclick: () => { s.contacts.splice(i, 1); drawContacts(); } }, "✕")))),
    h("button", { onclick: () => { s.contacts.push({ name: "", title: "", email: "", phone: "" }); drawContacts(); } }, "+ Contact"));
  drawContacts();
  $view.replaceChildren(h("h1", { style: "margin-bottom:16px" }, "Settings"),
    h("div", { class: "card", style: "margin-bottom:14px" }, h("h2", {}, "Header & footer"),
      h("div", { class: "settings-grid" }, field("Company name", "company"), field("Document title", "doc_title"),
        field("Confidentiality line", "confidential"), field("Contacts heading (cover)", "contacts_heading"))),
    h("div", { class: "card", style: "margin-bottom:14px" }, h("h2", {}, "Cover page contacts"),
      h("p", { class: "small muted" }, "The first contact is shown on its own; the rest are shown two per row."), contactsBox),
    h("div", { class: "card", style: "margin-bottom:14px" }, h("h2", {}, "Disclaimer (cover page)"), field("", "disclaimer", true)),
    h("button", { class: "primary", onclick: async () => { await api("PUT", "/api/settings", s); toast("Settings saved - all PDFs will use them"); } }, "Save settings"));
}

function bindPlain(obj, key, placeholder) {
  return h("input", { value: obj[key] ?? "", placeholder: placeholder || "", oninput: (e) => (obj[key] = e.target.value) });
}

// ------------------------------------------------------------------ start
api("GET", "/api/config").then((c) => (config = c)).catch(() => {}).finally(route);
