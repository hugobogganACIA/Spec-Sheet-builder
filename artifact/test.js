/* Quick checks for the artifact's pure modules. Run: npm i xlsx@0.18.5 && node artifact/test.js [workbook.xlsx ...] */
global.XLSX = require("xlsx");
require("./src/core.js"); require("./src/normalize.js"); require("./src/checks.js");
const fs = require("fs");
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error("FAIL", msg); } else console.log("ok  ", msg); };

// every extraction route builds its prompt (a broken template literal only shows on the route that uses it)
for (const src of ["workbook", "text", "images"]) {
  let p = "";
  try { p = SpecNormalize.extractionPrompt("R1: A=x", "f.xlsx", src); } catch (e) { p = "ERR " + e.message; }
  ok(p.includes('"f.xlsx"') && !p.startsWith("ERR"), `extraction prompt builds for ${src}`);
}
ok(SpecNormalize.verifyAgainstWorkbook({ general: { msn: "1072" } }, ["1072"]).length === 0, "verification accepts a value in the source");
ok(SpecNormalize.verifyAgainstWorkbook({ general: { msn: "9999" } }, ["1072"]).length === 1, "verification flags a value not in the source");

// real workbooks given on the command line: template parse -> standard layout keeps every value
for (const f of process.argv.slice(2)) {
  const r = SpecCore.importWorkbook(fs.readFileSync(f), f);
  const std = SpecNormalize.standardSpec(SpecNormalize.templateToData(r.spec), f);
  const flat = (spec) => { const o = {}; let hd = ""; for (const s of spec.sections) { if (s.type === "heading") { hd = s.title; continue; }
    if (s.type === "kv") s.rows.forEach((x) => (o[`${hd}|${s.title}|${x.label}`] = x.value));
    if (s.type === "grid") s.rows.forEach((x, i) => x.cells.forEach((c, j) => (o[`${hd}|${s.title}|${i}|${j}`] = c))); } return o; };
  const a = flat(r.spec), b = flat(std);
  ok(Object.keys(a).every((k) => !a[k] || a[k] === b[k]), `${f.split("/").pop()}: standard layout keeps every value`);
  ok(Array.isArray(SpecChecks.run(std, { today: Date.now() })), `${f.split("/").pop()}: checks run`);
}
process.exit(failed ? 1 : 0);
