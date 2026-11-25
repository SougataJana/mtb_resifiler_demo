"use strict";
// ResiFiler frontend: upload -> stepper (polls the backend) -> per-stage output -> final report.
// Every string from the server goes through esc() before it reaches the page.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const na = '<span class="muted">n/a</span>';
const row = (k, v) => `<tr><td>${esc(k)}</td><td>${v === null || v === undefined || v === "" ? na : v}</td></tr>`;
const kv = (obj, skip = []) => `<table>${Object.entries(obj).filter(([k, v]) => !skip.includes(k) && typeof v !== "object")
  .map(([k, v]) => row(k.replace(/_/g, " "), esc(v))).join("")}</table>`;
let jobId = null, timer = null, selected = null, cfg = null, viewer = null;

// ------------------------------------------------------------------ demo mode
// The page can be served statically (poster QR, GitHub Pages) with no backend: it then reads the
// precomputed results of the public ENA test isolates from data/*.json instead of calling the API.
// Nothing is simulated; these are the files the pipeline wrote. Live upload needs the FastAPI backend.
const DEMO = !!window.RESIFILER_DEMO;
let demoIndex = null, demoSample = null;

async function loadJson(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`could not load ${p} (HTTP ${r.status})`);
  return r.json();
}
async function demoApi(path) {
  if (path === "/api/config") { demoIndex = demoIndex || await loadJson("data/index.json"); return demoIndex; }
  const m = path.match(/^\/api\/jobs\/([^/?]+)([^?]*)(\?.*)?$/);
  if (!m) throw new Error("not available in the static demo");
  const [, id, rest, qs] = m;
  if (!demoSample || demoSample.id !== id) demoSample = await loadJson(`data/${id}.json`);
  const s = demoSample;
  if (!rest) return {
    id, state: "done", input_type: s.input_type, expires: null, error: null, report_ready: true,
    stages: demoIndex.stages.map(x => ({
      key: x.key, title: x.title,
      status: (x.key === "report" || s.stages[x.key]) ? "done" : "not_applicable",
      reason: (x.key === "report" || s.stages[x.key]) ? null : "no output for this input type"}))};
  if (rest.startsWith("/stages/")) {
    const k = rest.slice(8);
    if (k === "report") return s.report;
    if (!s.stages[k]) throw new Error("this stage has no output");
    return s.stages[k];
  }
  if (rest === "/variants") {
    const p2 = new URLSearchParams(qs || ""), off = +(p2.get("offset") || 0), lim = +(p2.get("limit") || 100);
    let rows = s.variants;
    if ((p2.get("scope") || "priority") === "priority") rows = rows.filter(r => r.priority);
    const q = (p2.get("q") || "").toLowerCase();
    if (q) rows = rows.filter(r => `${r.gene} ${r.variant} ${r.effect} ${r.type}`.toLowerCase().includes(q));
    return {total: rows.length, offset: off, rows: rows.slice(off, off + lim)};
  }
  throw new Error("not available in the static demo");
}
function demoDownload(kind) {
  const s = demoSample;
  let text, name, type = "text/tab-separated-values";
  if (kind === "report.json") { text = JSON.stringify(s.report, null, 1); type = "application/json"; }
  else if (kind === "drugs.tsv")
    text = ["drug\twho_call\tqualifier\tresistance_variants\tuncertain_variants\tfailed_loci",
      ...s.report.drug_calls.map(d => [d.drug, d.who_call, d.qualifier || "", d.resistance_variants.join(";"),
        d.uncertain_variants.join(";"), d.failed_loci.join(";")].join("\t"))].join("\n");
  else {
    const cols = ["pos", "ref", "alt", "type", "gene", "variant", "effect", "callers", "call_class",
                  "allele_fraction", "depth", "who_entry", "who_drug_grading", "who_rule"];
    text = [cols.join("\t"), ...s.variants.map(r => cols.map(c => r[c] ?? "").join("\t"))].join("\n");
  }
  name = `resifiler_${s.id}_${kind}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const ICON = {done: "✓", running: "●", queued: "…", failed: "✕", pending: "○", not_applicable: "–"};
const POINTS = {structure_view: "3D structure view", drug_distance: "Distance to drug (band)", pocket_membership: "Pocket / RRDR membership",
  solvent_accessibility: "Solvent accessibility", secondary_structure: "Secondary structure", catalytic_distance: "Distance to catalytic site",
  conservation: "Conservation (raw counts)", tolerated_residues: "Tolerated residues", property_change: "Property change",
  substitution_severity: "Substitution severity", synthesis: "Synthesis sentence", who_grade: "WHO grade",
  caller_af_depth: "Caller / allele fraction / depth", position: "Position", percent_protein_lost: "% protein lost",
  domains_and_catalytic_removed: "Domains and catalytic residues removed", lof_tolerance: "Loss-of-function tolerance",
  coordinates_and_size: "Coordinates and size", genes_affected: "Genes affected", fraction_of_gene_lost: "Fraction of gene lost",
  reason: "Reason", domain: "Pfam domain"};
const pt = k => POINTS[k] || k.replace(/_/g, " ");

// ------------------------------------------------------------------ boot + input
async function api(path, opt) {
  if (DEMO && !opt) return demoApi(path);
  const r = await fetch(path, opt);
  if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch (e) {} throw new Error(d || `HTTP ${r.status}`); }
  return r.json();
}

let chosen = null;        // {kind:"sample"|"file", id, inputType, label}
let advMode = false;
let comboKey = null;

const GLYPH = {critical: "▲", warning: "◆", serious: "■", good: "✓", info: "●"};
function statusClass(s) {
  s = String(s || "");
  if (s === "Resistant") return "critical";
  if (s.startsWith("Fail")) return "serious";
  if (s.startsWith("Uncertain")) return "warning";
  if (s.startsWith("No resistance")) return "good";
  return "info";
}
// a status always ships as glyph + word, so colour never carries the meaning alone
function statusChip(text) {
  const c = statusClass(text);
  return `<span class="chip ${c}"><span class="g" aria-hidden="true">${GLYPH[c]}</span>${esc(text)}</span>`;
}
function setState(step, text, cls) {
  const e = $("#" + step + "state");
  e.innerHTML = cls ? `<span class="g" aria-hidden="true">${GLYPH[cls] || ""}</span>${esc(text)}` : esc(text);
  e.className = "chip " + (cls || "");
}

(async function boot() {
  cfg = await api("/api/config");
  $("#banner").innerHTML = `<b>${esc(cfg.statement)}</b>`;
  $("#ref").textContent = cfg.reference;
  $("#limits").textContent = DEMO
    ? "FASTQ, FASTA or VCF. The file is checked in your browser and never uploaded from this page."
    : `${cfg.accepted.join("; ")}. Maximum ${cfg.max_upload_gb} GB (placeholder limit).`;
  $("#samples").innerHTML = (cfg.samples || []).map(s => `<li><button class="sample" data-id="${esc(s.id)}">
      <b>${esc(s.run)}</b><small>${esc(s.why)}</small>
      <small>${s.resistant.length ? "Resistant: " + s.resistant.map(esc).join(", ") : "No resistance-associated variant detected"}</small>
      </button></li>`).join("");
  document.querySelectorAll(".sample").forEach(b => b.onclick = () => pickSample(b.dataset.id));
  renderCombos();
  $("#runNote").textContent = DEMO
    ? "Running the pipeline needs the analysis server (alignment, calling and annotation run in containers). This page is served as static files, so it shows a completed run instead."
    : "The run takes several minutes; each stage appears as it finishes.";
  const h = location.hash.match(/job=([A-Za-z0-9_-]+)/);
  if (h) { pickSample(h[1], true); openJob(h[1]); }
})().catch(e => { $("#banner").textContent = "Could not load: " + e.message; });

// ---- sample isolates
$("#useSample").onclick = () => {
  const w = $("#samplesWrap");
  w.hidden = !w.hidden;
  if (!w.hidden) w.scrollIntoView({behavior: "smooth", block: "nearest"});
};
function pickSample(id, quiet) {
  const s = (cfg.samples || []).find(x => x.id === id);
  if (!s) return;
  chosen = {kind: "sample", id, inputType: "fastq_paired", label: s.run};
  $("#samplesWrap").hidden = false;
  $("#inputReport").hidden = false;
  $("#inputReport").innerHTML = `<h3>Input</h3><div class="stats">
    <div class="stat"><div class="v">${esc(s.run)}</div><div class="k">ENA run</div></div>
    <div class="stat"><div class="v">Illumina</div><div class="k">paired FASTQ</div></div>
    <div class="stat"><div class="v">${s.resistant.length}</div><div class="k">drugs with a resistance-associated variant</div></div></div>
    <p class="muted">${esc(s.why)}. Public data; already taken through the pipeline.</p>`;
  document.querySelectorAll(".sample").forEach(b => b.classList.toggle("sel", b.dataset.id === id));
  setState("s1", "test isolate", "good");
  $("#formMsg").textContent = "";
  afterInput();
  if (!quiet) $("#s2").scrollIntoView({behavior: "smooth", block: "start"});
}

// ---- real stage-1 inspection of an uploaded file, done in the browser
const DNA = /^[ACGTNRYSWKMBDHVacgtnryswkmbdhv]+$/;
async function readHead(file, bytes = 1 << 18) {
  const buf = await file.slice(0, bytes).arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return new TextDecoder().decode(buf);
  if (!("DecompressionStream" in window)) throw new Error("This browser cannot read .gz here. Try an uncompressed file.");
  const rd = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const dec = new TextDecoder();
  let out = "";
  try {                                   // the slice ends mid-member: keep whatever decoded first
    for (;;) { const {done, value} = await rd.read(); if (done) break; out += dec.decode(value, {stream: true}); }
  } catch (e) { /* expected on a truncated gzip slice */ }
  return out;
}
function inspect(text, file) {
  const lines = text.split("\n");
  if (lines.length > 2) lines.pop();                       // last line is probably cut
  const first = lines.find(l => l.trim());
  if (!first) throw new Error("The file starts with no readable text.");
  if (first.startsWith("##fileformat=VCF"))
    return {type: "vcf", label: "VCF", rows: lines.filter(l => l && !l.startsWith("#")).length, note:
      "Variant calling from a VCF is not built yet, so this input stops after validation."};
  if (first.startsWith(">")) {
    const seq = lines.filter(l => l && !l.startsWith(">"));
    const bases = seq.join("");
    const n = lines.filter(l => l.startsWith(">")).length;
    if (bases && !DNA.test(bases.slice(0, 2000).replace(/\s/g, ""))) throw new Error("The sequence lines are not DNA.");
    return {type: bases.length > 50000 ? "fasta_assembly" : "fasta_genes",
            label: bases.length > 50000 ? "FASTA assembly" : "gene FASTA",
            records: n, bases: bases.length, gc: gcOf(bases)};
  }
  if (first.startsWith("@")) {
    const recs = [];
    for (let i = 0; i + 3 < lines.length; i += 4)
      if (lines[i].startsWith("@") && lines[i + 2].startsWith("+")) recs.push(lines[i + 1]);
    if (!recs.length) throw new Error("This looks like FASTQ but no complete 4-line record was found.");
    const joined = recs.join("");
    if (!DNA.test(joined.slice(0, 2000))) throw new Error("The read sequences are not DNA.");
    return {type: "fastq", label: "FASTQ reads", records: recs.length, bases: joined.length,
            readLen: Math.round(joined.length / recs.length), gc: gcOf(joined)};
  }
  throw new Error("Unrecognised format: expected FASTQ, FASTA or VCF.");
}
const gcOf = s => s.length ? Math.round(1000 * (s.match(/[GCgc]/g) || []).length / s.length) / 10 : null;

async function handleFiles(list) {
  const files = [...list].slice(0, 2);
  if (!files.length) return;
  $("#formMsg").textContent = "";
  setState("s1", "checking", "info");
  $("#dropText").textContent = files.map(f => `${f.name} (${(f.size / 1e6).toFixed(0)} MB)`).join(", ");
  try {
    const r = inspect(await readHead(files[0]), files[0]);
    const mb = files.reduce((a, f) => a + f.size, 0) / 1e6;
    chosen = {kind: "file", id: null, label: r.label,
              inputType: r.type === "fastq" ? (files.length > 1 ? "fastq_paired" : "fastq_single") : r.type};
    $("#inputReport").hidden = false;
    $("#inputReport").innerHTML = `<h3>Checked in your browser</h3><div class="stats">
      <div class="stat"><div class="v">${esc(r.label)}</div><div class="k">format detected</div></div>
      ${r.records !== undefined ? `<div class="stat"><div class="v">${r.records.toLocaleString()}</div><div class="k">${r.type === "fastq" ? "reads" : "sequences"} in sample</div></div>` : ""}
      ${r.readLen ? `<div class="stat"><div class="v">${r.readLen} bp</div><div class="k">mean read length</div></div>` : ""}
      ${r.gc !== null && r.gc !== undefined ? `<div class="stat"><div class="v">${r.gc}%</div><div class="k">GC content</div></div>` : ""}
      <div class="stat"><div class="v">${mb.toFixed(0)} MB</div><div class="k">${files.length} file${files.length > 1 ? "s" : ""}</div></div></div>
      <p class="muted">Format, record structure, sequence alphabet and base composition were read from the first
      256 KB of the file, in this page. ${r.note ? esc(r.note) + " " : ""}The file was not uploaded anywhere.
      ${r.gc !== null && r.gc !== undefined && r.gc >= 60 && r.gc <= 70 ? "A GC content near 65% is consistent with <i>M. tuberculosis</i>; the species check itself runs in the pipeline." : ""}</p>`;
    setState("s1", "validated", "good");
    afterInput();
    $("#s2").scrollIntoView({behavior: "smooth", block: "start"});
  } catch (e) {
    chosen = null;
    $("#inputReport").hidden = true;
    $("#formMsg").textContent = e.message;
    setState("s1", "rejected", "critical");
    afterInput();
  }
}
const fileInput = $("#files");
fileInput.addEventListener("change", () => handleFiles(fileInput.files));
["dragover", "dragenter"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.add("over"); }));
["dragleave", "drop"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.remove("over"); }));
$("#drop").addEventListener("drop", ev => handleFiles(ev.dataTransfer.files));

// ---- step 2: the combination is chosen by what the input is
function comboFor(inputType) { return (inputType || "").startsWith("fastq") ? "fastq" : "fasta"; }
function renderCombos() {
  const combs = cfg.tool_combinations || {};
  const want = chosen ? comboFor(chosen.inputType) : null;
  $("#chooserLead").innerHTML = "Tools are not picked one stage at a time. A combination is validated <b>as a whole</b> "
    + "and was run end to end on the test data together, because a chain that looks reasonable at each step can still "
    + "be wrong overall: a short-read aligner used on assembled contigs is a valid tool and a wrong choice. "
    + (chosen ? "Your input selects the combination below." : "Provide a sequence above and the matching combination is selected.");
  $("#combos").innerHTML = Object.entries(combs).map(([k, c]) => {
    const ok = !chosen || k === want;
    return `<button class="combo ${k === comboKey ? "sel" : ""}" data-combo="${esc(k)}" ${ok ? "" : "disabled"}>
      <b>${esc(c.label)}</b><small>${esc(c.note)}</small>
      <small style="margin-top:6px">${ok ? (chosen ? "Matches your input · " : "") + c.stages.length + " stages, validated together"
        : "Not applicable to this input"}</small></button>`;
  }).join("");
  document.querySelectorAll("[data-combo]").forEach(b => b.onclick = () => { comboKey = b.dataset.combo; renderCombos(); });
  const it = comboKey === "fastq" ? "fastq_paired" : "fasta_assembly";
  $("#chainWrap").innerHTML = !comboKey ? "" : `<div class="tools modeswitch">
      <button class="${advMode ? "ghost" : ""} small" data-mode="std">Standard (recommended)</button>
      <button class="${advMode ? "" : "ghost"} small" data-mode="adv">Advanced (all stages)</button></div>`
    + (advMode ? advancedPanel(it) : toolPanel(it, true));
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { advMode = b.dataset.mode === "adv"; renderCombos(); });
  setState("s2", comboKey ? "selected" : "waiting", comboKey ? "good" : "");
}
function afterInput() {
  comboKey = chosen ? comboFor(chosen.inputType) : null;
  renderCombos();
  const ready = !!(chosen && chosen.kind === "sample");
  $("#sampleOut").disabled = !cfg.samples || !cfg.samples.length;
  $("#runBtn").disabled = DEMO || !chosen;
  setState("s3", ready ? "sample output ready" : (chosen ? "ready" : "waiting"), ready || chosen ? "info" : "");
}
$("#sampleOut").onclick = () => {
  const id = (chosen && chosen.kind === "sample") ? chosen.id : (cfg.samples[0] || {}).id;
  if (!id) return;
  pickSample(id, true);
  openJob(id);
  $("#job").scrollIntoView({behavior: "smooth", block: "start"});
};
$("#runBtn").onclick = async () => {
  if (DEMO || !chosen) return;
  const fd = new FormData();
  [...fileInput.files].forEach(f => fd.append("files", f));
  $("#runBtn").disabled = true; $("#formMsg").textContent = "Uploading and validating…";
  try { const r = await api("/api/jobs", {method: "POST", body: fd}); $("#formMsg").textContent = ""; openJob(r.id); }
  catch (e) { $("#formMsg").textContent = e.message; $("#runBtn").disabled = false; }
};

// ------------------------------------------------------------------ job + stepper
function openJob(id) {
  jobId = id; selected = null; location.hash = "job=" + id; $("#job").hidden = false; $("#panel").hidden = true;
  clearTimeout(timer); poll();
}
async function poll() {
  let s;
  try { s = await api(`/api/jobs/${jobId}`); } catch (e) { $("#jobError").textContent = e.message; return; }
  $("#jobState").textContent = s.state; $("#jobState").className = "chip " + (s.state === "done" ? "done" : s.state === "failed" ? "failed" : "running");
  const wh = ((cfg.tool_combinations || {}).fastq || {}).withheld;
  $("#jobMeta").innerHTML = esc(`Input: ${s.input_type || "?"} · ` + (DEMO
    ? `precomputed result for ENA run ${(cfg.samples.find(x => x.id === s.id) || {}).run || s.id}`
    : `results are deleted ${new Date(s.expires * 1000).toLocaleDateString()} · job ${s.id.slice(0, 8)}`))
    + (wh ? `<br><span class="withheld-inline">${esc(wh)}</span>` : "");
  $("#jobError").textContent = s.error || "";
  $("#stepper").innerHTML = s.stages.map(st => `<li class="step ${st.key === selected ? "sel" : ""}" data-k="${st.key}" tabindex="0" role="button">
      <span class="chip ${st.status === "done" ? "done" : st.status === "failed" ? "failed" : st.status === "not_applicable" ? "na" : st.status}${st.status === "running" ? " spin" : ""}"
        aria-label="${st.status}">${ICON[st.status]} ${st.status.replace("_", " ")}</span>
      <span class="t">${esc(st.title)}${st.reason ? `<small>${esc(st.reason)}</small>` : ""}</span></li>`).join("");
  document.querySelectorAll(".step").forEach(el => {
    const go = () => showStage(el.dataset.k, s.stages.find(x => x.key === el.dataset.k));
    el.onclick = go; el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
  const lastDone = [...s.stages].reverse().find(x => x.status === "done");
  if (lastDone && (selected === null || selected === "_auto")) { selected = "_auto"; await showStage(lastDone.key, lastDone, true); }
  if (s.state === "queued" || s.state === "running") timer = setTimeout(poll, 3000);
  else if (s.state === "done") { renderNotes(); if (selected === "_auto" || selected === null) showStage("report", s.stages.find(x => x.key === "report")); }
}
async function renderNotes() {
  try {
    const r = await api(`/api/jobs/${jobId}/stages/report`);
    $("#notes").hidden = !r.notes.length;
    $("#notes").innerHTML = "<h2>Notes for this report</h2><ul>" + r.notes.map(n => `<li>${esc(n)}</li>`).join("") + "</ul>";
  } catch (e) {}
}
async function showStage(key, st, auto) {
  if (!auto) selected = key;
  document.querySelectorAll(".step").forEach(el => el.classList.toggle("sel", el.dataset.k === key));
  const p = $("#panel"); p.hidden = false;
  if (st && st.status !== "done") { p.innerHTML = `<h2>${esc(st.title)}</h2><p>${st.status === "not_applicable" ? esc(st.reason) : st.status === "failed" ? esc(st.reason || "") : "Not finished yet."}</p>`; return; }
  try {
    const d = await api(`/api/jobs/${jobId}/stages/${key}`);
    p.innerHTML = `<h2>${esc(st ? st.title : key)}</h2>` + RENDER[key](d);
    if (key === "who") wireWho(); if (key === "report") wireReport(d);
    if (["calling", "annotation"].includes(key)) wireVariantsLink();
  } catch (e) { p.innerHTML = `<p class="msg">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------ stage renderers

const RENDER = {
  validation: d => kv(d),
  qc: d => `<h3>Species check</h3><p>${esc(d.species.verdict)}</p>${kv(d.species, ["verdict", "method", "hits", "possible_contamination"])}
    <p class="muted">${esc(d.species.method)}</p><h3>Read QC (before trimming)</h3>${d.qc ? kv(d.qc.raw) + kv({duplication_rate: d.qc.duplication_rate, adapter_detected: d.qc.adapter_detected}) +
      (d.qc.flags.length ? `<p class="msg">${d.qc.flags.map(esc).join("; ")}</p>` : "") : ""}<p class="muted">Thresholds are provisional placeholders.</p>`,
  trimming: d => `<p>${esc(d.tool)}: ${d.percent_reads_kept}% of reads kept (${d.reads_removed.toLocaleString()} removed).</p>
    <table class="grid"><tr><th></th><th>Reads</th><th>Bases</th><th>Q20</th><th>Q30</th><th>GC</th><th>Mean length</th></tr>
    ${["before", "after"].map(k => `<tr><td>${k}</td><td>${d[k].reads.toLocaleString()}</td><td>${d[k].bases.toLocaleString()}</td><td>${d[k].q20_rate}</td><td>${d[k].q30_rate}</td><td>${d[k].gc_content}</td><td>${d[k].mean_read_length}</td></tr>`).join("")}</table>
    <details><summary>Command</summary><pre>${esc(d.command)}</pre></details>`,
  alignment: d => kv(d, ["resistance_loci", "resistance_loci_failed", "thresholds", "note", "stage"]) +
    (d.resistance_loci_failed.length ? `<p class="msg">Low coverage (Fail, never susceptible): ${d.resistance_loci_failed.map(esc).join(", ")}</p>` : "<p>No resistance locus failed the coverage check.</p>") +
    `<h3>Depth across the resistance loci</h3><div class="tbl-wrap"><table class="grid"><tr><th>Gene</th><th>Interval</th><th>Mean depth</th><th>≥ min depth</th><th>Status</th></tr>
    ${(d.resistance_loci.n ? [] : d.resistance_loci).map(l => `<tr><td>${esc(l.gene)}</td><td>${esc(l.interval)}</td><td>${l.mean_depth}</td><td>${l.fraction_ge_10x}</td><td>${esc(l.status)}</td></tr>`).join("")}</table></div>
    <p class="muted">${esc(d.note)}</p>`,
  calling: d => {
    // the caller breakdown and the deletion-rejection rule are rendered separately; key names are
    // resolved generically so the published page carries no tool name in its source
    const ruleKey = Object.keys(d).find(k => k.endsWith("rejection_rule"));
    return `${kv(d, ["stage", "note", ruleKey])}
      <h3>By call class</h3>${kv(d.by_call_class || {})}
      <h3>By type</h3>${kv(d.by_type)}
      <p class="muted">${ruleKey ? esc(d[ruleKey]) + ". " : ""}${esc(d.note || "")}</p>${variantsLink()}`;
  },
  annotation: d => `<p>${esc(d.tool)}</p>${kv(d, ["stage", "tool", "variants", "large_deletions", "numbering_check"])}
    <h3>Numbering check against the WHO catalogue's genomic coordinates</h3>${kv(d.numbering_check, ["mismatch_examples"])}
    <p class="muted">${esc(d.numbering)}</p>${variantsLink()}`,
  who: d => `<p>${esc(d.catalogue)} · ${esc(d.reference)}. <b>This is the resistance call.</b> ${esc(d.thresholds_status)}.</p>
    <div class="tbl-wrap"><table class="grid"><tr><th>Drug</th><th>WHO catalogue call</th><th>Resistance-associated variants</th><th>Uncertain-significance variants</th></tr>
    ${Object.entries(d.drugs).map(([drug, v]) => `<tr><td>${esc(drug)}</td><td>${statusChip(v.status)}${v.qualifier ? `<br><small>${esc(v.qualifier)}</small>` : ""}
      ${v.failed_loci.length ? `<br><small>low coverage at ${v.failed_loci.map(esc).join(", ")}</small>` : ""}</td>
      <td>${v.resistance_variants.map(esc).join("<br>") || na}</td><td>${v.uncertain_variants.map(esc).join("<br>") || na}</td></tr>`).join("")}</table></div>`,
  report: d => `<p><b>${esc(d.title)}</b></p>${d.statement.map(s => `<p>${esc(s)}</p>`).join("")}
    <p>Reference: ${esc(d.reference)} · Catalogue: ${esc(d.catalogue)} · Preset: ${esc(d.preset)} · Poster freeze date: ${esc(d.poster_freeze_date)}</p>
    <div class="tools">${DEMO
      ? `<button data-dl="report.json">Download JSON</button><button data-dl="report.tsv">Download TSV (variants)</button>
         <button class="ghost" data-dl="drugs.tsv">Download TSV (drug calls)</button>`
      : `<a class="btn" href="/api/jobs/${jobId}/report.json">Download JSON</a><a class="btn" href="/api/jobs/${jobId}/report.tsv">Download TSV (variants)</a>
         <a class="btn ghost" href="/api/jobs/${jobId}/drugs.tsv">Download TSV (drug calls)</a>`}</div>
    ${toolPanel(d.input_type)}
    ${d.notes.length ? "<h3>Notes</h3><ul>" + d.notes.map(n => `<li>${esc(n)}</li>`).join("") + "</ul>" : ""}
    <h3>WHO catalogue calls per drug</h3><div id="rdrugs"></div>
    <h3>Variants</h3><div id="rvars"></div>`
};
const STAGE_NAMES = {species: "Species and contamination check", qc: "Read QC", trim: "Trimming",
  align_reads: "Alignment (reads)", align_assembly: "Alignment (assembly)", markdup: "Duplicate marking",
  coverage: "Coverage", call_majority: "Calling: majority alleles", call_lowfreq: "Calling: low-frequency alleles",
  call_largedel: "Calling: large deletions", calling: "Variant calling", annotate: "Annotation and numbering"};

function toolPanel(inputType, brief) {
  const combs = cfg.tool_combinations;
  if (!combs) return "";
  const key = (inputType || "").startsWith("fastq") ? "fastq" : "fasta";
  const c = combs[key];
  if (!c) return "";
  const other = combs[key === "fastq" ? "fasta" : "fastq"];
  return `${brief ? `<h3>What runs, and why each tool</h3>` : `<h3>Tool combination: ${esc(c.label)}</h3>
    <p class="muted">Tools are not picked one stage at a time. A combination is validated <b>as a whole</b> and was run
    end to end on the test data together, because a chain that looks reasonable at each step can still be wrong overall:
    a short-read aligner used on assembled contigs is valid as a tool and wrong as a choice. Selecting a tool outside the
    validated set stops the run with an explicit error rather than producing results, and any deviation is printed at the
    top of the report. Preset in use: <b>${esc(cfg.preset)}</b>.</p>
    <p>${esc(c.note)}</p>`}
    <ol class="chain">${c.stages.map(k => `<li><span class="t">${esc(STAGE_NAMES[k] || k)}</span><code>${esc(cfg.tools[k])}</code>
      <p>${esc((cfg.tool_rationale || {})[k] || "")}</p></li>`).join("")}</ol>
    ${c.withheld ? `<p class="muted withheld"><b>Not listed:</b> ${esc(c.withheld)}</p>` : ""}
    ${other && !brief ? `<p class="muted">The other combination, <b>${esc(other.label)}</b>, is selected automatically
      when that kind of input is uploaded. ${esc(other.note)}</p>` : ""}`;
}

// Advanced view: every stage as a real menu. Only a tool whose whole chain has been run end to end is
// selectable; every other option stays disabled and says why, so a selection can never be quietly
// swapped for something else at run time.
function advancedPanel(inputType) {
  const key = (inputType || "").startsWith("fastq") ? "fastq" : "fasta";
  const c = (cfg.tool_combinations || {})[key];
  if (!c) return "";
  const alts = cfg.tool_alternatives || {}, allowed = cfg.allowed_tools || {};
  const rows = c.stages.map(k => {
    const inUse = cfg.tools[k], ok = allowed[k] || [inUse];
    const opts = ok.map(t => `<option selected>${esc(t)}</option>`).join("")
      + (alts[k] || []).map(a => `<option disabled>${esc(a.tool)} — not in this build</option>`).join("");
    return `<div class="advrow">
      <label><span class="k">${esc(STAGE_NAMES[k] || k)}</span>
        <select aria-label="${esc(STAGE_NAMES[k] || k)}">${opts}</select></label>
      <p class="muted">${esc((cfg.tool_rationale || {})[k] || "")}</p>
      ${(alts[k] || []).map(a => `<p class="alt"><b>${esc(a.tool)}</b> ${esc(a.why)}</p>`).join("")}
    </div>`;
  }).join("");
  return `<p class="muted">Every stage is listed with the alternatives you might expect. A tool is selectable only
    where the whole chain containing it has been run end to end on the test data; the rest are disabled and say why.
    <b>Nothing is silently substituted</b>: an untested selection stops the run with an explicit error, so a report can
    never name one tool and have been produced by another.</p>
    <div class="advgrid">${rows}</div>
    ${c.withheld ? `<p class="muted withheld"><b>Not listed:</b> ${esc(c.withheld)}</p>` : ""}`;
}

const variantsLink = () => `<p><button class="ghost small" data-go="report">Open the full variant table in the report</button></p>`;
function wireVariantsLink() { document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => showStage(b.dataset.go)); }
function wireWho() {}


// ------------------------------------------------------------------ report: drugs + variants table
let vScope = "priority", vQ = "", vOff = 0;
function wireReport(d) {
  const n = k => d.drug_calls.filter(x => statusClass(x.who_call) === k).length;
  $("#rdrugs").innerHTML = `<div class="stats">
    <div class="stat"><div class="v">${n("critical")}</div><div class="k">drugs with a resistance-associated variant</div></div>
    <div class="stat"><div class="v">${n("warning")}</div><div class="k">uncertain significance</div></div>
    <div class="stat"><div class="v">${n("serious")}</div><div class="k">Fail, low coverage</div></div>
    <div class="stat"><div class="v">${n("good")}</div><div class="k">none detected</div></div></div>
    <div class="tbl-wrap"><table class="grid"><tr><th>Drug</th><th>WHO call</th><th>Resistance-associated</th><th>Uncertain</th><th>Failed loci</th></tr>
    ${d.drug_calls.map(v => `<tr><td>${esc(v.drug)}</td><td>${statusChip(v.who_call)}</td><td>${v.resistance_variants.map(esc).join("<br>") || na}</td>
    <td>${v.uncertain_variants.map(esc).join("<br>") || na}</td><td>${v.failed_loci.map(esc).join(", ") || na}</td></tr>`).join("")}</table></div>`;
  $("#rvars").innerHTML = `<div class="tools"><input type="search" id="vq" placeholder="Filter by gene / variant / effect">
    <button class="ghost small" id="vscope"></button><span class="muted" id="vcount"></span></div><div class="tbl-wrap"><table class="grid" id="vtbl"></table></div>
    <button class="ghost small" id="vmore" hidden>Show more</button>`;
  document.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => demoDownload(b.dataset.dl));
  $("#vq").oninput = () => { vQ = $("#vq").value; loadVars(true); };
  $("#vscope").onclick = () => { vScope = vScope === "priority" ? "all" : "priority"; loadVars(true); };
  $("#vmore").onclick = () => loadVars(false);
  loadVars(true);
}
async function loadVars(reset) {
  if (reset) { vOff = 0; $("#vtbl").innerHTML = `<tr><th>Gene</th><th>Variant</th><th>Effect</th><th>Calling</th><th>AF</th><th>Depth</th><th>WHO catalogue</th></tr>`; }
  const r = await api(`/api/jobs/${jobId}/variants?` + new URLSearchParams({scope: vScope, q: vQ, offset: vOff, limit: 100}));
  $("#vscope").textContent = vScope === "priority" ? "Show all variants" : "Show WHO / resistance-gene variants only";
  $("#vtbl").insertAdjacentHTML("beforeend", r.rows.map(v => `<tr><td>${esc(v.gene)}</td><td>${esc(v.variant || v.type)}</td><td>${esc(v.effect)}</td>
      <td>${esc(v.callers)}</td><td>${esc(v.allele_fraction)}</td><td>${esc(v.depth)}</td><td>${esc(v.who_drug_grading) || na}</td></tr>`).join(""));
  vOff += r.rows.length; $("#vcount").textContent = `${vOff} of ${r.total} shown`; $("#vmore").hidden = vOff >= r.total;
}
