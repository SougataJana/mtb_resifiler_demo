"use strict";
// MTB-ResiFiler dashboard. Layout follows mtb_app_v5: 1 Pipeline Configuration, 2 Submit New Job, 3 Job Dashboard,
// 4 Active Job Manager with ten step tabs, each showing that step's output. One difference on purpose: the tool
// choice is a validated combination (see config/pipeline.yaml), not a free pick per stage.
// A static page (poster QR) cannot run the pipeline, so it shows one stored sample output; with the backend the
// same page runs real jobs. Every string from the server goes through esc() before it reaches the page.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const na = '<span class="muted">n/a</span>';
const num = n => (n === null || n === undefined) ? "n/a" : Number(n).toLocaleString();
const pct = (f, d = 1) => (f === null || f === undefined) ? "n/a" : (100 * f).toFixed(d) + "%";
const human = n => n >= 1e9 ? (n / 1e9).toFixed(2) + " Gb" : n >= 1e6 ? (n / 1e6).toFixed(1) + " Mb" : num(n);
const row = (k, v) => `<tr><td>${esc(k)}</td><td>${v === null || v === undefined || v === "" ? na : v}</td></tr>`;
const tile = (k, v, sub) => `<div class="stat sm"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="k">${esc(sub)}</div>` : ""}</div>`;
const DEMO = !!window.RESIFILER_DEMO;
const SAMPLE = "sample";
let cfg = null, idx = null, chosen = null, advMode = false, selection = {}, JOB = null, jobs = [], pollT = null;
const cache = {};

// status always ships as glyph + words, never colour alone
const GLYPH = {critical: "▲", warning: "◆", serious: "■", good: "✓", info: "●", neutral: "●"};
const chip = (text, cls) => `<span class="chip ${cls || ""}"><span class="g" aria-hidden="true">${GLYPH[cls] || ""}</span>${esc(text)}</span>`;
const TYPE_CLASS = {"Fixed resistance": "critical", "Heteroresistance": "serious", "Uncertain significance (grade 3)": "warning",
  "Not assessed": "info", "Fail (low coverage)": "serious", "No resistance-associated variant detected": "good"};
const typeChip = t => chip(t, TYPE_CLASS[t] || "info");
function setState(id, text, cls) {
  const e = $("#" + id + "state");
  e.innerHTML = `${cls ? `<span class="g" aria-hidden="true">${GLYPH[cls] || ""}</span>` : ""}${esc(text)}`;
  e.className = "chip " + (cls || "");
}

// ------------------------------------------------------------------ data access
async function loadJson(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`could not load ${p} (HTTP ${r.status})`);
  return r.json();
}
async function demoApi(path) {
  if (path === "/api/config") return idx;
  const m = path.match(/^\/api\/jobs\/sample(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("not available in the static page");
  const s = cache.sample = cache.sample || await loadJson("data/sample.json");
  const rest = m[1] || "";
  if (!rest) return {id: SAMPLE, state: "done", input_type: s.input_type, error: null,
    stages: idx.stages.map(x => ({key: x.key, title: x.title, status: (x.key === "report" || s.stages[x.key]) ? "done" : "not_applicable"}))};
  if (rest.startsWith("/stages/")) {
    const k = rest.slice(8);
    if (k === "report") return s.report;
    if (!s.stages[k]) throw new Error("this stage has no output");
    return s.stages[k];
  }
  throw new Error("not available in the static page");
}
async function api(path, opt) {
  if (DEMO || /^\/api\/jobs\/sample(\/|$)/.test(path)) return demoApi(path);
  const r = await fetch(path, opt);
  if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch (e) {} throw new Error(d || `HTTP ${r.status}`); }
  return r.json();
}
const stageOf = async (key) => {
  const k = JOB.id + ":" + key;
  return cache[k] = cache[k] || await api(`/api/jobs/${JOB.id}/stages/${key}`);
};

// ------------------------------------------------------------------ boot
(async function boot() {
  idx = await loadJson("data/index.json").catch(() => null);
  cfg = DEMO ? idx : await api("/api/config");
  $("#banner").innerHTML = `<b>${esc(cfg.statement)}</b>`;
  $("#ref").textContent = cfg.reference;
  $("#limits").textContent = DEMO
    ? "FASTQ, FASTA or VCF. The file is checked in your browser and never uploaded from this page."
    : `${cfg.accepted.join("; ")}. Maximum ${cfg.max_upload_gb} GB (placeholder limit).`;
  $("#runNote").textContent = DEMO
    ? "Running the pipeline needs the analysis server: alignment, calling and annotation run in containers, and this page is served as static files. It shows one stored sample output instead."
    : "The run takes several minutes; each step's output appears in its tab as the step finishes.";
  $("#sampleOut").disabled = !(idx && idx.sample);
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { advMode = b.dataset.mode === "adv"; if (!advMode) selection = {}; renderConfig(); });
  renderConfig(); renderDash();
  const h = location.hash.match(/job=([A-Za-z0-9_-]+)/);
  if (h) openJob(h[1]);
})().catch(e => { $("#banner").textContent = "Could not load: " + e.message; });

// ------------------------------------------------------------------ 1. Pipeline Configuration
const STAGE_NAMES = {qc: "Read QC", trim: "Trimming",
  align_reads: "Alignment (reads)", align_assembly: "Alignment (assembly)", markdup: "Duplicate marking",
  coverage: "Coverage", calling: "Variant calling", annotate: "Annotation",
  mutation_db: "Mutation database", reference: "Reference genome", visualization: "Visualisation"};
const TOOL_LABEL = {who_catalogue_v2: "WHO catalogue v2", h37rv_nc_000962_3: "H37Rv", builtin_charts: "built-in charts"};
const toolLabel = t => TOOL_LABEL[t] || t;
const comboFor = t => (t || "").startsWith("fastq") ? "fastq" : t ? "fasta" : "fastq";

function renderConfig() {
  const combs = cfg.tool_combinations || {}, key = comboFor(chosen && chosen.inputType), c = combs[key];
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("ghost", (b.dataset.mode === "adv") !== advMode));
  $("#chooserLead").innerHTML = "Tools are not picked one stage at a time. A combination is validated <b>as a whole</b> and was run end to end "
    + "on the test data together, because a chain that looks reasonable at each step can still be wrong overall: a short-read aligner used on "
    + "assembled contigs is a valid tool and a wrong choice. " + (chosen ? "Your input selects the combination below." : "Provide a sequence below and the matching combination is selected.");
  $("#combos").innerHTML = Object.entries(combs).map(([k, x]) => {
    const ok = k === key;
    return `<button class="combo ${ok ? "sel" : ""}" ${ok ? "" : "disabled"}><b>${esc(x.label)}</b><small>${esc(x.note)}</small>
      <small style="margin-top:6px">${ok ? (chosen ? "Matches your input · " : "Default · ") + x.stages.length + " stages, validated together" : "Not applicable to this input"}</small></button>`;
  }).join("");
  $("#chainWrap").innerHTML = !c ? "" : (advMode ? advancedPanel(c) : chainPanel(c));
  document.querySelectorAll("#chainWrap select[data-stage]").forEach(sel => sel.onchange = () => { selection[sel.dataset.stage] = sel.value; renderConfig(); });
  const rs = $("#resetStd"); if (rs) rs.onclick = () => { selection = {}; renderConfig(); };
  const bad = invalidSelections();
  setState("s1", bad.length ? "Option not enabled" : (advMode ? "Advanced view" : c ? "Standard" : "waiting"), bad.length ? "warning" : (c ? (advMode ? "info" : "good") : ""));
  updateRun();
}
function chainPanel(c) {
  return `<h3>What runs, and why each tool</h3><ol class="chain">${c.stages.map(k => `<li><span class="t">${esc(STAGE_NAMES[k] || k)}</span>
    <code>${esc(toolLabel(cfg.tools[k]))}</code>${(cfg.tool_rationale || {})[k] ? `<p>${esc(cfg.tool_rationale[k])}</p>` : ""}</li>`).join("")}</ol>`;
}
// Advanced: every stage is a real menu and every option is selectable. Only a tool whose whole chain has been run end
// to end can actually run. Picking any other is allowed, but it is flagged, Start is blocked with the reason, and the
// server refuses it too, so a report can never name one tool and have been produced by another.
function chainStages() { const c = (cfg.tool_combinations || {})[comboFor(chosen && chosen.inputType)]; return c ? c.stages : []; }
function invalidSelections() {
  const alts = cfg.tool_alternatives || {}, out = [];
  chainStages().forEach(k => {
    const v = selection[k];
    if (v && !(cfg.allowed_tools[k] || []).includes(v)) out.push({k, tool: v, why: ((alts[k] || []).find(a => a.tool === v) || {}).why || ""});
  });
  return out;
}
function advancedPanel(c) {
  const alts = cfg.tool_alternatives || {}, allowed = cfg.allowed_tools || {}, lockedSt = cfg.locked_stages || [], bad = invalidSelections();
  return `${bad.length ? `<div class="who guard" role="alert"><p><b>Not enabled in this version:</b>
      ${bad.map(x => esc(`${STAGE_NAMES[x.k] || x.k}: ${x.tool}`)).join("; ")}.
      <button class="small ghost" id="resetStd">Reset to Standard</button></p></div>` : ""}
    <p class="muted">The sample output uses the Standard tools. The other options are not enabled in this version.</p>
    <div class="advgrid">${c.stages.map(k => {
      const ok = allowed[k] || [cfg.tools[k]], locked = lockedSt.includes(k), cur = selection[k] || ok[0];
      const alt = (alts[k] || []).find(a => a.tool === cur);
      const opts = ok.map(t => `<option value="${esc(t)}" ${t === cur ? "selected" : ""}>${esc(toolLabel(t))}</option>`).join("")
        + (alts[k] || []).map(a => `<option value="${esc(a.tool)}" ${a.tool === cur ? "selected" : ""}>${esc(a.tool)}</option>`).join("");
      return `<div class="advrow ${locked ? "locked" : ""} ${alt ? "flag" : ""}"><label><span class="k">${esc(STAGE_NAMES[k] || k)}${locked ? ` ${chip("fixed", "info")}` : ""}</span>
        <select data-stage="${esc(k)}" aria-label="${esc(STAGE_NAMES[k] || k)}" ${locked ? "disabled" : ""}>${opts}</select></label>
        <p class="muted">${esc(alt ? alt.why : ((cfg.tool_rationale || {})[k] || ""))}</p></div>`;
    }).join("")}</div>`;
}

// ------------------------------------------------------------------ 2. Submit New Job: real format check in the browser
const DNA = /^[ACGTNRYSWKMBDHVacgtnryswkmbdhv]+$/;
const gcOf = s => s.length ? Math.round(1000 * (s.match(/[GCgc]/g) || []).length / s.length) / 10 : null;
async function readHead(file, bytes = 1 << 18) {
  const buf = await file.slice(0, bytes).arrayBuffer(), u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return new TextDecoder().decode(buf);
  if (!("DecompressionStream" in window)) throw new Error("This browser cannot read .gz here. Try an uncompressed file.");
  const rd = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")).getReader(), dec = new TextDecoder();
  let out = "";
  try { for (;;) { const {done, value} = await rd.read(); if (done) break; out += dec.decode(value, {stream: true}); } } catch (e) { /* truncated slice */ }
  return out;
}
function inspect(text) {
  const lines = text.split("\n");
  if (lines.length > 2) lines.pop();
  const first = lines.find(l => l.trim());
  if (!first) throw new Error("The file starts with no readable text.");
  if (first.startsWith("##fileformat=VCF")) return {type: "vcf", label: "VCF", records: lines.filter(l => l && !l.startsWith("#")).length,
    note: "Variant calling from a VCF is not built yet, so this input stops after validation."};
  if (first.startsWith(">")) {
    const bases = lines.filter(l => l && !l.startsWith(">")).join(""), n = lines.filter(l => l.startsWith(">")).length;
    if (bases && !DNA.test(bases.slice(0, 2000))) throw new Error("The sequence lines are not DNA.");
    return {type: bases.length > 50000 ? "fasta_assembly" : "fasta_genes", label: bases.length > 50000 ? "FASTA assembly" : "gene FASTA", records: n, gc: gcOf(bases)};
  }
  if (first.startsWith("@")) {
    const recs = [];
    for (let i = 0; i + 3 < lines.length; i += 4) if (lines[i].startsWith("@") && lines[i + 2].startsWith("+")) recs.push(lines[i + 1]);
    if (!recs.length) throw new Error("This looks like FASTQ but no complete 4-line record was found.");
    const j = recs.join("");
    if (!DNA.test(j.slice(0, 2000))) throw new Error("The read sequences are not DNA.");
    return {type: "fastq", label: "FASTQ reads", records: recs.length, readLen: Math.round(j.length / recs.length), gc: gcOf(j)};
  }
  throw new Error("Unrecognised format: expected FASTQ, FASTA or VCF.");
}
async function handleFiles(list) {
  const files = [...list].slice(0, 2);
  if (!files.length) return;
  $("#formMsg").textContent = "";
  setState("s2", "checking", "info");
  $("#dropText").textContent = files.map(f => `${f.name} (${(f.size / 1e6).toFixed(0)} MB)`).join(", ");
  try {
    const r = inspect(await readHead(files[0])), mb = files.reduce((a, f) => a + f.size, 0) / 1e6;
    const name = files[0].name.replace(/_?[12]?\.(fastq|fq|fasta|fa|fna|vcf)(\.gz)?$/i, "");
    chosen = {kind: "file", name, label: r.label, inputType: r.type === "fastq" ? (files.length > 1 ? "fastq_paired" : "fastq_single") : r.type};
    $("#inputReport").hidden = false;
    $("#inputReport").innerHTML = `<h3>Checked in your browser</h3><div class="stats">
      ${tile("Format detected", r.label)}${r.records !== undefined ? tile(r.type === "fastq" ? "Reads in sample" : "Records", num(r.records)) : ""}
      ${r.readLen ? tile("Mean read length", r.readLen + " bp") : ""}${r.gc != null ? tile("GC content", r.gc + "%") : ""}${tile("Size", mb.toFixed(0) + " MB", files.length + " file" + (files.length > 1 ? "s" : ""))}</div>
      <p class="muted">Format, record structure, sequence alphabet and base composition were read from the first 256 KB, in this page. ${r.note ? esc(r.note) + " " : ""}The file was not uploaded anywhere.
      ${r.gc != null && r.gc >= 60 && r.gc <= 70 ? "A GC content near 65% is consistent with <i>M. tuberculosis</i>." : ""}</p>`;
    setState("s2", "validated", "good");
    renderConfig();
  } catch (e) {
    chosen = null; $("#inputReport").hidden = true; $("#formMsg").textContent = e.message;
    setState("s2", "rejected", "critical"); renderConfig();
  }
}
const fileInput = $("#files");
fileInput.addEventListener("change", () => handleFiles(fileInput.files));
["dragover", "dragenter"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.add("over"); }));
["dragleave", "drop"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.remove("over"); }));
$("#drop").addEventListener("drop", ev => handleFiles(ev.dataTransfer.files));
$("#runBtn").onclick = async () => {
  if (DEMO || !chosen) return;
  const fd = new FormData();
  [...fileInput.files].forEach(f => fd.append("files", f));
  fd.append("tools", JSON.stringify(Object.fromEntries(chainStages().filter(k => !(cfg.locked_stages || []).includes(k)).map(k => [k, selection[k] || (cfg.allowed_tools[k] || [])[0]]))));
  $("#runBtn").disabled = true; $("#formMsg").textContent = "Uploading and validating…";
  try {
    const r = await api("/api/jobs", {method: "POST", body: fd});
    $("#formMsg").textContent = "";
    jobs.unshift({id: r.id, kind: "live", name: chosen.name || "uploaded sample", created: new Date()});
    openJob(r.id);
  } catch (e) { $("#formMsg").textContent = e.message; $("#runBtn").disabled = false; }
};
$("#sampleOut").onclick = () => {
  if (!idx || !idx.sample) return;
  if (!jobs.some(j => j.id === SAMPLE)) jobs.push({id: SAMPLE, kind: "sample", name: idx.sample.run + " (sample output)", created: null});
  openJob(SAMPLE);
  $("#s4").scrollIntoView({behavior: "smooth", block: "start"});
};

function updateRun() {
  const bad = invalidSelections();
  $("#runBtn").disabled = DEMO || !chosen || bad.length > 0;
  $("#runBtn").title = bad.length ? "A selected tool is not enabled in this version" : "";
  const n = $("#runNote");
  if (bad.length) n.textContent = "Start is blocked: " + bad.map(x => `${STAGE_NAMES[x.k] || x.k} \u2192 ${x.tool}`).join("; ") + " is not enabled in this version. Reset to Standard in step 1.";
  else n.textContent = DEMO
    ? "Running the pipeline needs the analysis server: alignment, calling and annotation run in containers, and this page is served as static files. It shows one stored sample output instead."
    : "The run takes several minutes; each step's output appears in its tab as the step finishes.";
}

// ------------------------------------------------------------------ 3. Job Dashboard
function renderDash() {
  $("#dashEmpty").hidden = jobs.length > 0; $("#dashWrap").hidden = !jobs.length;
  $("#dash").innerHTML = `<tr><th>Sample</th><th>Status</th><th>Current step</th><th>Submitted</th><th></th></tr>` + jobs.map(j => {
    const st = j.status, state = j.kind === "sample" ? "done" : (st ? st.state : "queued");
    const cur = j.kind === "sample" ? "all steps complete" : st ? ((st.stages.find(x => x.status !== "done" && x.status !== "not_applicable") || {}).title || "complete") : "queued";
    return `<tr><td>${esc(j.name)}</td><td>${chip(state === "done" ? "Completed" : state === "failed" ? "Failed" : state === "running" ? "Running" : "Queued",
        state === "done" ? "good" : state === "failed" ? "critical" : "info")}</td><td>${esc(cur)}</td>
      <td>${j.created ? esc(j.created.toLocaleTimeString()) : "stored"}</td><td><button class="small ${JOB && JOB.id === j.id ? "" : "ghost"}" data-manage="${esc(j.id)}">Manage</button></td></tr>`;
  }).join("");
  document.querySelectorAll("[data-manage]").forEach(b => b.onclick = () => openJob(b.dataset.manage));
}

// ------------------------------------------------------------------ 4. Active Job Manager
const TABS = [
  {k: "qc", label: "1. QC", stage: "qc"}, {k: "trim", label: "2. Trimming", stage: "trimming"},
  {k: "align", label: "3. Alignment", stage: "alignment"}, {k: "bamqc", label: "4. BAM QC", stage: "alignment"},
  {k: "bamproc", label: "5. BAM Processing", stage: "alignment"}, {k: "call", label: "6. Variant Calling", stage: "calling"},
  {k: "ann", label: "7. Annotation", stage: "annotation"}, {k: "filt", label: "8. Filtering", stage: "who"},
  {k: "rep", label: "9. Report", stage: "report"}, {k: "ai", label: "10. AI Prediction", stage: null}];
let sel = "qc";

async function openJob(id) {
  clearTimeout(pollT);
  JOB = {id, kind: id === SAMPLE ? "sample" : "live", status: null};
  if (!jobs.some(j => j.id === id)) jobs.unshift({id, kind: JOB.kind, name: JOB.kind === "sample" ? "sample output" : "job " + id.slice(0, 8), created: null});
  location.hash = "job=" + id;
  $("#mgrEmpty").hidden = true; $("#mgr").hidden = false; sel = "qc";
  await refresh(true);
}
async function refresh(first) {
  const j0 = JOB;
  let s;
  try { s = await api(`/api/jobs/${j0.id}`); } catch (e) { $("#jobError").textContent = e.message; return; }
  if (JOB !== j0) return;
  const prev = JOB.status; JOB.status = s;
  const rec = jobs.find(x => x.id === j0.id); if (rec) rec.status = s;
  $("#jobError").textContent = s.error || "";
  const j = jobs.find(x => x.id === j0.id);
  $("#mgrTitle").innerHTML = `Managing pipeline for <b>${esc(j ? j.name : j0.id)}</b>`;
  renderDash(); renderTabs();
  const stageNow = (TABS.find(t => t.k === sel) || {}).stage, was = prev && prev.stages.find(x => x.key === stageNow), now = s.stages.find(x => x.key === stageNow);
  if (first || !was || (now && was.status !== now.status)) showTab(sel);
  if (s.state === "queued" || s.state === "running") pollT = setTimeout(refresh, 3000);
}
function renderTabs() {
  const st = k => JOB.status && JOB.status.stages.find(x => x.key === k);
  $("#tabs").innerHTML = TABS.map(t => {
    const s = t.stage ? st(t.stage) : null, status = !t.stage ? "dev" : s ? s.status : "pending";
    const g = status === "done" ? GLYPH.good : status === "running" ? GLYPH.info : status === "failed" ? GLYPH.critical : status === "dev" ? GLYPH.warning : "○";
    return `<button class="tab" role="tab" data-tab="${t.k}" aria-selected="${t.k === sel}" title="${esc(status)}"><span class="g" aria-hidden="true">${g}</span> ${esc(t.label)}</button>`;
  }).join("");
  document.querySelectorAll("#tabs .tab").forEach(b => b.onclick = () => { sel = b.dataset.tab; renderTabs(); showTab(sel); });
}
async function showTab(k) {
  const t = TABS.find(x => x.k === k), p = $("#tabpanel");
  if (t.k === "ai") { p.innerHTML = tabAI(); return; }
  const s = JOB.status && JOB.status.stages.find(x => x.key === t.stage);
  const status = s ? s.status : "pending";
  if (status !== "done") {
    p.innerHTML = `<h3>${esc(t.label.replace(/^\d+\.\s*/, ""))}</h3>` + (status === "failed" ? `<p class="msg">${esc(s.reason || "This step failed.")}</p>`
      : status === "not_applicable" ? `<p class="muted">${esc((s && s.reason) || "No output for this input type.")}</p>`
      : status === "running" ? `<p>${chip("Running", "info")} The output appears here when this step finishes.</p>` : `<p class="muted">Waiting for the earlier steps to finish.</p>`);
    return;
  }
  p.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    let html;
    if (k === "ann") html = tabAnn(await stageOf("annotation"));
    else if (k === "filt") html = tabFilt(await stageOf("who"), await stageOf("annotation").catch(() => null));
    else if (k === "rep") html = await tabReport();
    else html = TAB_RENDER[k](await stageOf(t.stage));
    if (sel !== k) return;
    p.innerHTML = html;
    wireTab(k);
  } catch (e) { p.innerHTML = `<p class="msg">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------ tab renderers: the output of each step
const okTag = "✓";
const info = t => `<p class="info">${chip(t, "good")}</p>`;
const pre = t => `<pre>${esc(t)}</pre>`;
const qcUrl = () => JOB.kind === "sample" ? "data/sample_qc.html" : `/api/jobs/${JOB.id}/qc.html`;

function tabQC(d) {
  const r = d.qc.raw, q = d.qc;
  return `<h3>QC results</h3>${info("QC step completed")}
    <div class="stats">${tile("Reads", num(r.reads))}${tile("Bases", human(r.bases))}${tile("Q20 bases", pct(r.q20_rate))}${tile("Q30 bases", pct(r.q30_rate))}
      ${tile("GC content", pct(r.gc_content))}${tile("Mean read length", r.mean_read_length + " bp")}${tile("Duplication", pct(q.duplication_rate))}${tile("Adapter detected", q.adapter_detected ? "yes" : "no")}</div>
    ${(q.flags || []).length ? `<p class="msg">${q.flags.map(esc).join("; ")}</p>` : `<p class="muted">No QC flag raised. Thresholds are provisional placeholders.</p>`}
    <details class="grp"><summary>View the read QC report (fastp)</summary><div class="inner"><p class="muted">The report loads its charts from the internet.</p>
      <iframe class="qcframe" src="${esc(qcUrl())}" title="fastp QC report" loading="lazy"></iframe></div></details>`;
}
function tabTrim(d) {
  const b = d.before, a = d.after, rem = d.removed_by_reason || {};
  return `<h3>Trimming results</h3>${info("Trimming step completed")}
    <div class="stats">${tile("Reads kept", d.percent_reads_kept + "%", num(a.reads) + " of " + num(b.reads))}${tile("Reads removed", num(d.reads_removed))}${tile("Adapter-trimmed reads", num(d.adapter_trimmed_reads))}${tile("Tool", d.tool)}</div>
    <div class="tbl-wrap"><table class="grid"><tr><th></th><th>Reads</th><th>Bases</th><th>Q20</th><th>Q30</th><th>GC</th><th>Mean length</th></tr>
    ${[["Before", b], ["After", a]].map(([n, x]) => `<tr><td>${n}</td><td>${num(x.reads)}</td><td>${human(x.bases)}</td><td>${pct(x.q20_rate)}</td><td>${pct(x.q30_rate)}</td><td>${pct(x.gc_content)}</td><td>${x.mean_read_length} bp</td></tr>`).join("")}</table></div>
    <details class="grp"><summary>Show trimming log</summary><div class="inner">${pre(d.command)}
      <table>${Object.entries(rem).map(([k, v]) => row(k.replace(/_/g, " "), num(v))).join("")}</table></div></details>`;
}
function tabAlign(d) {
  return `<h3>Alignment results</h3>${info("Alignment generated and indexed")}
    <div class="stats">${tile("Aligner", d.aligner)}${tile("Reads (primary)", num(d.reads_total_primary))}${tile("Mapped", num(d.reads_mapped_primary))}${tile("Mapping rate", pct(d.mapping_rate, 2))}</div>
    <p class="muted">Reads are aligned to ${esc(cfg.reference)}, the coordinate system the WHO catalogue uses.</p>`;
}
function tabBamQC(d) {
  const loci = d.resistance_loci || [], bad = loci.filter(l => l.status !== "PASS");
  return `<h3>BAM QC metrics</h3>${info("BAM QC completed")}
    <div class="stats">${tile("Mean depth", d.mean_depth + "×")}${tile("Genome at ≥ 10×", d.percent_genome_ge_10x + "%")}${tile("Resistance loci passing", `${loci.length - bad.length} / ${loci.length}`)}${tile("Loci failing depth", String(bad.length))}</div>
    ${bad.length ? `<p>${chip("Low coverage", "serious")} ${bad.map(l => esc(l.gene)).join(", ")}. A failed locus is reported <b>Fail</b>, never susceptible.</p>` : `<p class="muted">Every resistance locus has adequate depth.</p>`}
    <details class="grp"><summary>Depth across the resistance loci (${loci.length})</summary><div class="inner tbl-wrap scroll"><table class="grid">
      <tr><th>Gene</th><th>Interval</th><th>Mean depth</th><th>≥ min depth</th><th>Status</th></tr>
      ${loci.map(l => `<tr><td>${esc(l.gene)}</td><td>${esc(l.interval)}</td><td>${l.mean_depth}</td><td>${l.fraction_ge_10x}</td><td>${chip(l.status, l.status === "PASS" ? "good" : "serious")}</td></tr>`).join("")}</table></div></details>
    <p class="muted">${esc(d.note || "")}</p>`;
}
function tabBamProc(d) {
  return `<h3>Pre-processing results</h3>${info("De-duplicated BAM generated")}
    <div class="stats">${tile("Duplicate rate", pct(d.duplicate_rate, 2), "marked, not removed")}${tile("Processing", "sorted + indexed")}</div>
    <ul class="muted"><li>Coordinate-sorted and indexed.</li><li>Read group assigned (single library).</li><li>PCR duplicates marked, so they are not counted as independent support for a variant.</li></ul>`;
}
function tabCall(d) {
  const t = d.by_type || {}, c = d.by_call_class || {};
  return `<h3>Variant calling results</h3>${info("Variant calling completed")}
    <p class="muted">an orchestrated variant caller</p>
    <div class="stats">${tile("Variants called", num(d.n_small_variants))}${tile("SNVs", num(t.SNV))}${tile("Indels", num(t.indel))}${tile("Large deletions", num(d.n_large_deletions))}</div>
    <h3>By call class</h3><div class="stats">${Object.entries(c).map(([k, v]) => tile(k, num(v))).join("")}</div>
    <details class="grp"><summary>View VCF file preview</summary><div class="inner">${pre(d.vcf_preview)}<p class="muted">First 40 variants by position. ${esc(d.note || "")}</p></div></details>`;
}
function tabAnn(d) {
  const eff = Object.entries(d.by_effect || {}).slice(0, 10), nc = d.numbering_check || {};
  return `<h3>Step 7: Annotate variants</h3>${info("Annotation completed")}
    <div class="stats">${tile("Variants annotated", num(d.n_variants))}${tile("In catalogue genes", num(d.n_in_catalogue_genes), "coding and non-coding")}${tile("Numbering check", `${nc.matches}/${nc.variants_checked}`, "match WHO coordinates")}${tile("Tool", d.tool && d.tool.split(",")[0])}</div>
    <h3>Annotation summary</h3>${barChart(eff, "Variants by predicted effect")}
    <h3>Gene annotation table</h3>
    <details class="grp"><summary>View gene-level statistics</summary><div class="inner"><div class="tbl-wrap scroll"><table class="grid"><tr><th>Gene</th><th>Variants</th></tr>
      ${(d.top_genes || []).map(([g, n]) => `<tr><td>${esc(g)}</td><td>${n}</td></tr>`).join("")}</table></div></div></details>
    <details class="grp" open><summary>Coding variants in WHO catalogue genes (${(d.catalogue_gene_variants || []).length})</summary><div class="inner"><div class="tbl-wrap scroll"><table class="grid">
      <tr><th>Gene</th><th>Change</th><th>Effect</th><th>Allele fraction</th></tr>
      ${(d.catalogue_gene_variants || []).map(v => `<tr><td>${esc(v.gene)}</td><td>${esc(v.hgvs_p || v.hgvs_c)}</td><td>${esc(v.effect)}</td><td>${esc(v.allele_fraction)}</td></tr>`).join("")}</table></div></div></details>
    <h3>Download results</h3><div class="tools"><button data-dl="variants">Download annotated variants (TSV)</button></div>`;
}
function tabFilt(w, a) {
  const rows = w.profile || [], n = t => rows.filter(r => r.type === t).length, lin = w.lineage;
  return `<h3>Step 8: Variant filtering &amp; lineage classification</h3>
    <p><b>Current pipeline mode:</b> ${esc(w.catalogue)}. ${chip("WHO catalogue v2 mode", "info")}</p>
    ${info("Resistance profiling: done")}${lin ? info("Lineage: " + lin.result) : ""}
    <div class="stats">${tile("Fixed resistance", String(n("Fixed resistance")), "grade 1–2, AF ≥ " + Math.round(100 * w.fixed_af) + "%")}${tile("Heteroresistance", String(n("Heteroresistance")), "grade 1–2, below that")}
      ${tile("Uncertain (grade 3)", String(n("Uncertain significance (grade 3)")))}${tile("Not assessed", String(n("Not assessed")))}${tile("Fail (low coverage)", String(n("Fail (low coverage)")))}</div>
    <h3>How the profile is read</h3><ul class="muted">
      <li>Grade 1–2 variants give resistance: <b>fixed</b> at or above ${Math.round(100 * w.fixed_af)}% allele fraction, <b>heteroresistance</b> below it. Calls under 5% are not listed.</li>
      <li>Grade 3 variants are listed as <b>uncertain significance</b>; they are not counted as resistance.</li>
      <li>${w.apply_lof_rules ? "Loss-of-function and deletion rules are applied." : "Loss-of-function and deletion rules are <b>not applied</b> for now: a frameshift, stop-gain or gene deletion in a catalogue gene is reported <b>Not assessed</b>, never susceptible."}</li>
      <li>Low coverage at a resistance locus is reported <b>Fail</b>, never susceptible.</li></ul>
    <label class="muted"><input type="checkbox" disabled> Apply advanced false-positive filtration (machine learning) — in development</label>`;
}
function tabAI() {
  return `<h3>AI prediction</h3><div class="who"><p>${chip("in development", "warning")}</p>
    <p>Our machine-learning framework for MIC prediction is in development and is not part of this run. Nothing on this page is predicted by it, and no performance figure is claimed.</p></div>`;
}
const TAB_RENDER = {qc: tabQC, trim: tabTrim, align: tabAlign, bamqc: tabBamQC, bamproc: tabBamProc, call: tabCall};

// ------------------------------------------------------------------ 9. Report: lineage, profile, landscape, downloads
const GROUP_ORDER = {};
function profileTable(rows) {
  let g = "";
  return `<div class="tbl-wrap"><table class="grid"><tr><th>Clinical group</th><th>Drug</th><th>Gene / mutation</th><th>Confidence</th><th>Genomic change (NC_000962.3)</th><th>Frequency</th><th>Resistance type</th></tr>
    ${rows.map(r => { const first = r.group !== g; g = r.group;
      return `<tr class="${first ? "gstart" : ""}"><td>${first ? esc(r.group) : ""}</td><td>${esc(r.drug)}</td><td>${esc(r.mutation) || na}</td><td>${esc(r.confidence) || na}</td>
        <td>${esc((r.change || "").replace("NC_000962.3:", "")) || na}</td><td>${r.frequency === null ? na : r.frequency + "%"}</td><td>${typeChip(r.type)}</td></tr>`; }).join("")}</table></div>`;
}
async function tabReport() {
  const w = await stageOf("who"), rep = await stageOf("report"), ann = await stageOf("annotation").catch(() => null);
  const rows = w.profile || [], lin = w.lineage, n = t => rows.filter(r => r.type === t).length;
  const genes = landGenes(w, ann);
  return `<h3>Results: clinical report</h3>
    ${(rep.notes || []).length ? `<ul class="muted">${rep.notes.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <h3>Phylogenetic classification</h3>${lin ? `<div class="who"><p class="synthesis">${chip(lin.mixed ? "Mixed / contaminated" : "Strain identity", lin.mixed ? "critical" : "good")} <b>${esc(lin.result)}</b>${lin.family ? ` · ${esc(lin.family)}` : ""}</p>
      <p class="muted">${esc(lin.method)}. ${num(lin.calls_scanned)} majority-call positions scanned. Thresholds are taken from the earlier app and are not validated here.</p></div>` : `<p class="muted">Lineage information not available.</p>`}
    <h3>Drug resistance profile</h3>
    <div class="stats">${tile("Fixed resistance", String(n("Fixed resistance")))}${tile("Heteroresistance", String(n("Heteroresistance")))}${tile("Uncertain (grade 3)", String(n("Uncertain significance (grade 3)")))}${tile("Not assessed", String(n("Not assessed")))}${tile("Fail (low coverage)", String(n("Fail (low coverage)")))}</div>
    ${profileTable(rows)}
    <p class="muted">Source: ${esc(rep.catalogue || w.catalogue)} on ${esc(rep.reference)}. The call comes only from the catalogue. Thresholds are provisional placeholders. No accuracy is claimed.</p>
    <h3>Mutation landscape</h3>${genes.length ? `<div class="tools"><label class="muted">Gene <select id="landGene">${genes.map(g => `<option>${esc(g)}</option>`).join("")}</select></label></div>
      <div id="landChart">${landscapeSvg(genes[0], w, ann)}</div>` : `<p class="muted">No coding variant with a catalogue grade to plot.</p>`}
    <h3>Download clinical report</h3><div class="tools"><button data-dl="csv">Download report (CSV)</button><button data-dl="html">Download clinical report (HTML)</button>
      <button class="ghost" data-dl="json">JSON</button><button class="ghost" data-dl="tsv">Variants (TSV)</button></div>`;
}

// ------------------------------------------------------------------ charts (validated palette; one measure each)
function barChart(entries, label) {
  if (!entries.length) return `<p class="muted">No data.</p>`;
  const max = Math.max(...entries.map(e => e[1])), W = 560, rowH = 24, L = 190, H = entries.length * rowH + 10;
  const bars = entries.map(([k, v], i) => { const w = Math.max(2, (W - L - 60) * v / max), y = 4 + i * rowH;
    return `<text x="${L - 8}" y="${y + 14}" text-anchor="end" font-size="12" fill="var(--ink-2)">${esc(k.replace(/_/g, " "))}</text>
      <path d="M${L},${y} H${L + w - 4} Q${L + w},${y} ${L + w},${y + 4} V${y + 12} Q${L + w},${y + 16} ${L + w - 4},${y + 16} H${L} Z" fill="var(--series-1)"/>
      <text x="${L + w + 6}" y="${y + 13}" font-size="12" font-weight="650" fill="var(--ink)">${num(v)}</text>`; }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${bars}</svg></div>
    <details><summary>Table view</summary><table>${entries.map(([k, v]) => row(k.replace(/_/g, " "), num(v))).join("")}</table></details>`;
}
const AA = {Ala: "A", Arg: "R", Asn: "N", Asp: "D", Cys: "C", Gln: "Q", Glu: "E", Gly: "G", His: "H", Ile: "I", Leu: "L", Lys: "K", Met: "M", Phe: "F", Pro: "P", Ser: "S", Thr: "T", Trp: "W", Tyr: "Y", Val: "V"};
const shortP = p => (p || "").replace(/^p\./, "").replace(/([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2}|\*|fs)?/, (m, a, n, b) => (AA[a] || a) + n + (b ? (AA[b] || b) : ""));
function landVars(gene, w, ann) {
  const prof = {};
  (w.profile || []).forEach(r => {
    if (!r.mutation) return;
    const c = (r.type === "Fixed resistance" || r.type === "Heteroresistance") ? "res" : /grade 3/.test(r.type) ? "unc" : null;
    if (c === "res" || (c === "unc" && prof[r.mutation] !== "res")) prof[r.mutation] = c;
  });
  return ((ann && ann.catalogue_gene_variants) || []).filter(v => v.gene === gene && v.aa_pos).map(v => ({
    pos: v.aa_pos, len: v.protein_length, af: v.allele_fraction, name: shortP(v.hgvs_p), cat: prof[`${gene}_${v.hgvs_p}`] || "other"}));
}
function landGenes(w, ann) {
  const gs = [...new Set(((ann && ann.catalogue_gene_variants) || []).filter(v => v.aa_pos).map(v => v.gene))];
  const score = g => landVars(g, w, ann).reduce((a, v) => a + (v.cat === "res" ? 100 : v.cat === "unc" ? 10 : 1), 0);
  return gs.sort((a, b) => score(b) - score(a));
}
// lollipop: x = codon, height = allele fraction; category by marker shape AND colour (never colour alone)
function landscapeSvg(gene, w, ann) {
  const v = landVars(gene, w, ann);
  if (!v.length) return `<p class="muted">No coding variant in ${esc(gene)}.</p>`;
  const L = Math.max(...v.map(x => x.len || 0), ...v.map(x => x.pos)), W = 620, H = 210, pl = 42, pr = 12, pt = 24, pb = 32;
  const x = p => pl + (W - pl - pr) * p / L, y = f => pt + (H - pt - pb) * (1 - f);
  const step = [50, 100, 200, 250, 500, 1000].find(s => L / s <= 8) || 1000;
  const ticks = []; for (let t = 0; t <= L; t += step) ticks.push(t);
  const mark = (c, cx, cy) => c === "res" ? `<path d="M${cx},${cy - 7} L${cx + 6.5},${cy + 5} L${cx - 6.5},${cy + 5} Z" fill="var(--critical)" stroke="var(--ink)" stroke-width="1"/>`
    : c === "unc" ? `<path d="M${cx},${cy - 7} L${cx + 6},${cy} L${cx},${cy + 7} L${cx - 6},${cy} Z" fill="var(--warning)" stroke="var(--ink)" stroke-width="1"/>`
    : `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--ink-2)" opacity=".75"/>`;
  const sorted = [...v].sort((a, b) => a.pos - b.pos);
  let lastX = -99, lvl = 0;
  const pts = sorted.map(p => { const cx = x(p.pos), cy = y(p.af ?? 1); lvl = cx - lastX < 34 ? (lvl + 1) % 3 : 0; lastX = cx;
    return `<line x1="${cx}" x2="${cx}" y1="${y(0)}" y2="${cy}" stroke="var(--border-strong)" stroke-width="1.5"/>${mark(p.cat, cx, cy)}
      ${p.cat !== "other" ? `<text x="${cx}" y="${cy - 11 - lvl * 11}" text-anchor="middle" font-size="11" font-weight="650" fill="var(--ink)">${esc(p.name)}</text>` : ""}
      <title>${esc(gene)} ${esc(p.name)} · AF ${p.af}</title>`; }).join("");
  return `<div class="legend"><span>${chip("resistance-associated (grade 1–2)", "critical")}</span><span>${chip("uncertain (grade 3)", "warning")}</span><span>${chip("other variant in the gene", "neutral")}</span></div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Variants along ${esc(gene)} by codon, height is allele fraction">
      ${[0, .5, 1].map(f => `<line x1="${pl}" x2="${W - pr}" y1="${y(f)}" y2="${y(f)}" stroke="var(--border)"/><text x="${pl - 6}" y="${y(f) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${f * 100}%</text>`).join("")}
      ${ticks.map(t => `<text x="${x(t)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="var(--muted)">${t}</text>`).join("")}
      <text x="${W / 2}" y="${H - 1}" text-anchor="middle" font-size="10" fill="var(--muted)">codon (${esc(gene)}, ${L} aa)</text>${pts}</svg></div>`;
}

// ------------------------------------------------------------------ downloads (generated in the page from the same data)
function save(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const csvCell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function profileCsv(rows) {
  return ["Clinical Group,Drug,Gene/Mutation,Confidence,Genomic Change,Frequency (%),Resistance Type", ...rows.map(r =>
    [r.group, r.drug, r.mutation, r.confidence, r.change, r.frequency ?? "", r.type].map(csvCell).join(","))].join("\n");
}
async function variantsTsv() {
  if (JOB.kind !== "sample") { const r = await fetch(`/api/jobs/${JOB.id}/report.tsv`); return r.text(); }
  const s = cache.sample, cols = ["pos", "ref", "alt", "type", "gene", "variant", "effect", "callers", "call_class", "allele_fraction", "depth", "who_entry", "who_drug_grading", "who_rule"];
  return [cols.join("\t"), ...s.variants.map(r => cols.map(c => r[c] ?? "").join("\t"))].join("\n");
}
function wireTab(k) {
  document.querySelectorAll("[data-dl]").forEach(b => b.onclick = async () => {
    const w = await stageOf("who"), name = (jobs.find(j => j.id === JOB.id) || {}).name || JOB.id, kind = b.dataset.dl;
    if (kind === "variants" || kind === "tsv") save(`${name}_variants.tsv`, await variantsTsv(), "text/tab-separated-values");
    else if (kind === "csv") save(`${name}_resistance_report.csv`, profileCsv(w.profile), "text/csv");
    else if (kind === "json") save(`${name}_report.json`, JSON.stringify(await stageOf("report"), null, 1), "application/json");
    else if (kind === "html") save(`${name}_clinical_report.html`, await clinicalHtml(name), "text/html");
  });
  const g = $("#landGene");
  if (g) g.onchange = async () => { $("#landChart").innerHTML = landscapeSvg(g.value, await stageOf("who"), await stageOf("annotation")); };
}
async function clinicalHtml(name) {
  const w = await stageOf("who"), rep = await stageOf("report"), ann = await stageOf("annotation").catch(() => null), lin = w.lineage;
  const genes = landGenes(w, ann).filter(g => landVars(g, w, ann).some(v => v.cat !== "other")).slice(0, 4);
  const css = `body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:980px;margin:24px auto;padding:0 16px}h1{margin:0 0 4px}h2{margin:26px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
    table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccc;padding:5px 8px;text-align:left}th{background:#f1f1ee}.note{color:#555;font-size:12px}
    .banner{border:1px solid #b88100;border-left:4px solid #b88100;padding:8px 12px;background:#fffaf0;margin:12px 0}svg{max-width:100%;height:auto}
    :root{--critical:#d03b3b;--warning:#fab219;--ink:#111;--ink-2:#444;--muted:#666;--border:#ddd;--border-strong:#bbb;--serious:#ec835a;--good:#0ca30c;--accent:#1d6fa5;--series-1:#2a78d6}
    .chip{display:inline-block;border:1px solid #999;border-radius:99px;padding:0 8px;font-size:12px;margin-right:6px}.legend{margin:6px 0}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>MTB-ResiFiler report: ${esc(name)}</title><style>${css}</style></head><body>
    <h1>MTB-ResiFiler report: ${esc(name)}</h1>
    <p class="note">Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · Reference ${esc(rep.reference)} · Poster freeze date: [FILL IN]</p>
    <div class="banner"><b>${esc(cfg.statement)}</b></div>
    <h2>Detected lineage</h2><p>${lin ? `<b>${esc(lin.result)}</b>${lin.family ? " · " + esc(lin.family) : ""}` : "not available"}</p>
    <h2>1. Drug resistance profile</h2>${profileTable(w.profile)}
    <p class="note">The call comes only from the ${esc(rep.catalogue || w.catalogue)}. Grade 1–2: fixed resistance at allele fraction ≥ ${Math.round(100 * w.fixed_af)}%, heteroresistance below it;
    grade 3 is uncertain significance and is not counted as resistance; loss-of-function and deletion rules are ${w.apply_lof_rules ? "applied" : "not applied (such variants are Not assessed)"}; low coverage is Fail, never susceptible.</p>
    ${genes.length ? `<h2>2. Mutation landscape</h2>${genes.map(g => `<h3>${esc(g)}</h3>${landscapeSvg(g, w, ann)}`).join("")}` : ""}
    <h2>Methodology &amp; references</h2><ul class="note"><li>Pipeline: validated tool combination (${esc(Object.values(cfg.tools || {}).join(", "))}); variant calling by MTB-ResiFiler's orchestrated caller (method unpublished).</li>
    <li>Lineage: SNP barcode scoring (as in mtb_app_v5). Taxonomy: Coll et al. (2014), Nat Commun. Phylogenetic markers: Freschi et al. (2021), Nat Commun. M. bovis typology: Zwyer et al. (2021), Front Microbiol.</li>
    <li>Drug resistance: WHO catalogue of mutations in <i>M. tuberculosis</i> complex and their association with drug resistance, v2 (2023).</li>
    <li>All thresholds are provisional placeholders. No accuracy figure is claimed for this pipeline.</li></ul></body></html>`;
}
