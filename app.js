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
  if (rest === "/explain")
    throw new Error("On-demand evidence is built by the evidence service, which this static page has no access to. The live pipeline at the poster can build it.");
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
                  "allele_fraction", "depth", "who_entry", "who_drug_grading", "who_rule",
                  "evidence_state", "evidence_tier", "evidence_points"];
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

// ------------------------------------------------------------------ boot + upload
async function api(path, opt) {
  if (DEMO && !opt) return demoApi(path);
  const r = await fetch(path, opt);
  if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch (e) {} throw new Error(d || `HTTP ${r.status}`); }
  return r.json();
}
(async function boot() {
  cfg = await api("/api/config");
  $("#banner").innerHTML = `<b>${esc(cfg.statement)}</b> Preset: ${esc(cfg.preset)}.`;
  $("#ref").textContent = cfg.reference;
  if (DEMO) {
    $("#upload").hidden = true;
    $("#picker").hidden = false;
    $("#pickerNote").textContent = cfg.built_from;
    $("#samples").innerHTML = cfg.samples.map(s => `<li><button class="sample" data-id="${esc(s.id)}">
        <b>${esc(s.run)}</b><small>${esc(s.why)}</small>
        <small>${s.resistant.length ? "Resistant: " + s.resistant.map(esc).join(", ") : "No resistance-associated variant detected"}</small>
        <small>${s.cards} evidence cards</small></button></li>`).join("");
    document.querySelectorAll(".sample").forEach(b => b.onclick = () => openJob(b.dataset.id));
  } else {
    $("#limits").textContent = `Accepted: ${cfg.accepted.join("; ")}. Maximum ${cfg.max_upload_gb} GB per upload (placeholder limit).`;
    $("#purge").textContent = cfg.purge_after_days;
  }
  const h = location.hash.match(/job=([A-Za-z0-9_-]+)/);
  if (h) openJob(h[1]);
})().catch(e => { $("#banner").textContent = "Could not load: " + e.message; });

const fileInput = $("#files");
function showChosen() {
  const n = fileInput.files.length;
  $("#dropText").textContent = n ? `${n} file${n > 1 ? "s" : ""} selected (${[...fileInput.files].map(f => (f.size / 1e6).toFixed(0) + " MB").join(", ")})` : "Choose files or drop them here";
  $("#go").disabled = n < 1 || n > 2;
  $("#formMsg").textContent = n > 2 ? "Upload one file, or two files for paired FASTQ." : "";
}
fileInput.addEventListener("change", showChosen);
["dragover", "dragenter"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.add("over"); }));
["dragleave", "drop"].forEach(e => $("#drop").addEventListener(e, ev => { ev.preventDefault(); $("#drop").classList.remove("over"); }));
$("#drop").addEventListener("drop", ev => { fileInput.files = ev.dataTransfer.files; showChosen(); });
$("#form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const fd = new FormData();
  [...fileInput.files].forEach(f => fd.append("files", f));
  $("#go").disabled = true; $("#formMsg").textContent = "Uploading and validating…";
  try { const r = await api("/api/jobs", {method: "POST", body: fd}); $("#formMsg").textContent = ""; openJob(r.id); }
  catch (e) { $("#formMsg").textContent = e.message; $("#go").disabled = false; }
});

// ------------------------------------------------------------------ job + stepper
function openJob(id) {
  jobId = id; selected = null; location.hash = "job=" + id; $("#job").hidden = false; $("#panel").hidden = true;
  clearTimeout(timer); poll();
}
async function poll() {
  let s;
  try { s = await api(`/api/jobs/${jobId}`); } catch (e) { $("#jobError").textContent = e.message; return; }
  $("#jobState").textContent = s.state; $("#jobState").className = "chip " + (s.state === "done" ? "done" : s.state === "failed" ? "failed" : "running");
  $("#jobMeta").textContent = `Input: ${s.input_type || "?"} · ` + (DEMO
    ? `precomputed result for ENA run ${(cfg.samples.find(x => x.id === s.id) || {}).run || s.id}`
    : `results are deleted ${new Date(s.expires * 1000).toLocaleDateString()} · job ${s.id.slice(0, 8)}`);
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
  else if (s.state === "done") { renderNotes(); if (selected === "_auto" || selected === null) showStage("report", s.stages[8]); }
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
    if (key === "who") wireWho(); if (key === "explain") wireCards(p); if (key === "report") wireReport(d);
    if (["calling", "annotation"].includes(key)) wireVariantsLink();
  } catch (e) { p.innerHTML = `<p class="msg">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------ stage renderers
const chipFor = s => s === "Resistant" ? "R" : s.startsWith("Fail") ? "Fail" : s.startsWith("Uncertain") ? "U" : "";
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
    ${Object.entries(d.drugs).map(([drug, v]) => `<tr><td>${esc(drug)}</td><td><span class="chip ${chipFor(v.status)}">${esc(v.status)}</span>${v.qualifier ? `<br><small>${esc(v.qualifier)}</small>` : ""}
      ${v.failed_loci.length ? `<br><small>low coverage at ${v.failed_loci.map(esc).join(", ")}</small>` : ""}</td>
      <td>${v.resistance_variants.map(esc).join("<br>") || na}</td><td>${v.uncertain_variants.map(esc).join("<br>") || na}</td></tr>`).join("")}</table></div>`,
  explain: d => `<p>${esc(d.evidence_package)}. ${d.notes.map(esc).join(" ")}</p>
    <p>${d.summary.cards} cards shown up front (WHO catalogue genes and large deletions in them); ${d.summary.other_variants} other variants can be explained on request in the report table.</p>
    <div id="cards">${d.cards.filter(c => !["no_evidence"].includes(c.state)).map(renderCard).join("")}
    <details><summary>${d.cards.filter(c => c.state === "no_evidence").length} variants with no evidence available (reason shown)</summary>
    ${d.cards.filter(c => c.state === "no_evidence").map(renderCard).join("")}</details></div>`,
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
function toolPanel(inputType) {
  const combs = cfg.tool_combinations;
  if (!combs) return "";
  const key = (inputType || "").startsWith("fastq") ? "fastq" : "fasta";
  const c = combs[key];
  if (!c) return "";
  const names = {species: "Species and contamination check", qc: "Read QC", trim: "Trimming",
    align_reads: "Alignment (reads)", align_assembly: "Alignment (assembly)", markdup: "Duplicate marking",
    coverage: "Coverage", call_majority: "Calling: majority alleles", call_lowfreq: "Calling: low-frequency alleles",
    call_largedel: "Calling: large deletions", annotate: "Annotation and numbering"};
  const other = combs[key === "fastq" ? "fasta" : "fastq"];
  return `<h3>Tool combination: ${esc(c.label)}</h3>
    <p class="muted">Tools are not picked one stage at a time. A combination is validated <b>as a whole</b> and was run
    end to end on the test data together, because a chain that looks reasonable at each step can still be wrong overall:
    a short-read aligner used on assembled contigs is valid as a tool and wrong as a choice. Each tool below says why it
    is the one used for this kind of data. Selecting a tool outside the validated set stops the run with an explicit
    error rather than producing results, and any deviation is printed at the top of the report.
    Preset in use: <b>${esc(cfg.preset)}</b>.</p>
    <p>${esc(c.note)}</p>
    <ol class="chain">${c.stages.map(k => `<li><b>${esc(names[k] || k)}</b> <code>${esc(cfg.tools[k])}</code>
      <p class="muted">${esc((cfg.tool_rationale || {})[k] || "")}</p></li>`).join("")}</ol>
    ${other ? `<p class="muted">The other combination, <b>${esc(other.label)}</b>, is selected automatically when that
      kind of input is uploaded. ${esc(other.note)}</p>` : ""}`;
}
const variantsLink = () => `<p><button class="ghost small" data-go="report">Open the full variant table in the report</button></p>`;
function wireVariantsLink() { document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => showStage(b.dataset.go)); }
function wireWho() {}

// ------------------------------------------------------------------ evidence cards
function whoBlock(w) {
  if (!w) return "";
  if (!w.listed) return `<div class="who"><span class="muted">WHO catalogue v2</span> · <b>${esc(w.label)}</b></div>`;
  return `<div class="who"><span class="muted">WHO catalogue v2 (unchanged)</span> · <b>${esc(w.variant)}</b><br>${w.rows.map(r => `${esc(r.drug)}: ${esc(r.label || r.grading)}`).join("<br>")}</div>`;
}
function callBlock(c, note) {
  if (!c) return note ? `<p class="muted">${esc(note)}</p>` : "";
  const a = c.allele_fraction_note;
  const cl = c.callers || [];
  return `<h3>Call</h3><table>${row(cl.length > 1 ? "Callers" : "Calling", esc(cl.join(" + ")))}${row("Call class", esc(c.call_class))}
    ${row("Allele fraction", c.allele_fraction === null ? na : esc(c.allele_fraction))}${row("Depth", c.depth === null ? na : esc(c.depth))}
    ${a ? row("Allele-fraction note", esc(a.note) + (a.warnings || []).map(w => `<br>${esc(w)}`).join("")) : ""}</table>`;
}
function missenseBody(e) {
  const n = e.numbering, s = e.structure, d = e.drug_site, c = e.conservation, p = e.property_change, v = e.substitution_severity;
  const st = n.structure;
  const tol = c ? Object.entries(c.observed_counts).filter(([, k]) => k > 0).sort((a, b) => b[1] - a[1]).map(([a, k]) => `${a}: ${k}`).join(", ") : "";
  return `<h3>Numbering</h3><table>${row("Mtb (WHO / H37Rv)", esc(n.mtb_label))}${row("UniProt", n.uniprot ? esc(n.uniprot.accession + " " + n.uniprot.pos) : null)}
    ${row("Structure residue", st ? esc(`${st.source} ${st.id}${st.chain ? " chain " + st.chain : ""}, residue ${st.auth_resnum ?? "-"}`) : null)}${n.ecoli ? row("E. coli", esc(n.ecoli.aa + n.ecoli.pos)) : ""}</table>
    <h3>Structure</h3><table>${row("Model", esc(s.source))}${row("Burial (relative SASA)", s.burial ? esc(`${s.burial} (${s.relative_solvent_accessibility})`) : null)}
    ${row("Secondary structure", esc(s.secondary_structure))}${row("Domain", esc(e.domain))}
    ${s.catalytic_site ? row("Catalytic site", esc(s.catalytic_site.definition + ": " + (s.catalytic_site.is_catalytic_residue ? "this is a catalytic residue" : s.catalytic_site.distance_band))) : ""}
    ${s.low_confidence ? row("Confidence", "<b>low confidence (pLDDT &lt; 70): structural values are not used</b>") : ""}${s.note ? row("Note", esc(s.note)) : ""}</table>
    <h3>Drug site</h3>${d ? `<table>${row("Ligand", esc(d.ligand))}${row("Distance to ligand (band)", esc(d.ligand_distance_band))}${row("Pocket", esc((d.pocket || "") + (d.pocket ? (d.in_pocket ? ": inside" : ": outside") : "")))}</table>` : `<p>${esc(e.drug_site_note || "no drug-binding site defined for this gene")}</p>`}
    <h3>Conservation</h3>${c ? `<table>${row("Counts (headline)", `<b>${esc(c.headline)}</b>`)}${row("Label", esc(c.label))}
    ${row("Weighted frequency of Mtb residue (secondary)", c.ref_frequency_weighted !== null ? esc(`${c.ref_frequency_weighted} (95% interval ${c.ref_frequency_ci95.join("–")})`) : null)}
    ${row("Residues observed here", esc(tol))}${e.alt_count ? row("Variant residue", esc(`${e.alt_count.aa} in ${e.alt_count.count} of ${e.alt_count.of}`)) : ""}
    ${row("Gap fraction / percentile in protein", esc(`${c.gap_fraction} / ${c.percentile_within_protein}`))}${c.note ? row("Note", esc(c.note)) : ""}</table>` : na}
    <h3>Substitution</h3><table>${p ? row("Property change", esc(`charge ${p.charge_change >= 0 ? "+" : ""}${p.charge_change}, volume ${p.volume_change >= 0 ? "+" : ""}${p.volume_change} Å3, hydrophobicity ${p.hydrophobicity_change >= 0 ? "+" : ""}${p.hydrophobicity_change}`)) : ""}
    ${v ? row("Severity", esc(`BLOSUM62 ${v.blosum62}, Grantham ${v.grantham} (${v.grantham_class}; ${v.grantham_bands})`)) : ""}</table>`;
}
function renderCard(c) {
  let body = "";
  if (c.state === "missense") body = missenseBody(c.evidence);
  else if (c.state === "truncation") {
    const t = c.truncation, l = c.lof_tolerance;
    body = `<table>${row("Protein length", t.protein_length)}${row("First residue lost / altered", t.first_residue_lost)}${row("% protein lost", t.percent_protein_lost)}
      ${row("Domains affected", (t.pfam_domains_affected || []).map(x => esc(`${x.name} (${x.effect})`)).join("<br>") || (t.pfam_note ? esc(t.pfam_note) : null))}
      ${t.catalytic_site ? row("Catalytic site", esc(`${t.catalytic_site.definition}; lost: ${t.catalytic_site.residues_lost.join(", ") || "none"}`)) : ""}
      ${row("Loss-of-function tolerance", esc(`${l.label} (TnSeq ${l.tnseq_call || "n/a"}). ${l.source}`))}</table><p class="muted">${esc(t.note || "")}</p>`;
  } else if (c.state === "large_deletion") {
    const dl = c.deletion;
    body = `<table>${row("Coordinates", esc(`${dl.start}–${dl.end} (${dl.size_bp} bp)`))}</table><div class="tbl-wrap"><table class="grid"><tr><th>Gene</th><th>Fraction lost</th><th>Loss-of-function tolerance</th></tr>
      ${dl.genes.map(g => `<tr><td>${esc(g.gene)}</td><td>${esc(g.fraction_of_gene_deleted)}</td><td>${esc(g.lof_tolerance ? g.lof_tolerance.label : "")}</td></tr>`).join("")}</table></div>`;
  } else if (c.reason) body = `<p>${esc(c.reason)}</p>`;
  if (c.state === "tier2_on_demand" || c.state === "not_built") {
    const v = c.variant || {};
    body += `<p><button class="small" data-explain='${esc(JSON.stringify({pos: v.pos, ref: v.ref, alt: v.alt}))}'>Build the evidence for this variant</button></p>`;
  }
  const mol = c.state === "missense" && c.evidence.numbering.structure && c.evidence.numbering.structure.source === "PDB"
    ? `<button class="ghost small" data-mol='${esc(JSON.stringify(c.evidence.numbering.structure))}'>3D view</button><div class="viewer-slot"></div>` : "";
  const chip = c.state === "no_evidence" ? "na" : c.state === "fail_low_coverage" ? "Fail" : "";
  return `<details class="cardx"><summary><b>${esc(c.title)}</b><span class="chip ${chip}">${esc(c.state.replace(/_/g, " "))}</span>
      <span class="chip">${c.tier ? "Tier " + c.tier : ""}</span><span class="muted">${(c.evidence_points || []).length} evidence points</span></summary>
    <div class="body">${whoBlock(c.who_catalogue)}${c.synthesis ? `<p class="synthesis">${esc(c.synthesis)}</p>` : ""}${mol}${body}
    <h3>Evidence points shown</h3><div class="pts">${(c.evidence_points || []).map(k => `<span class="chip">${esc(pt(k))}</span>`).join("")}</div>
    ${callBlock(c.call, c.call_note)}<p class="disc">${esc(c.disclaimer || "")}</p></div></details>`;
}
function wireCards(root) {
  root.querySelectorAll("[data-mol]").forEach(b => b.onclick = () => openMol(b));
  root.querySelectorAll("[data-explain]").forEach(b => b.onclick = () => explainInto(b, JSON.parse(b.dataset.explain)));
}
function openMol(btn) {
  const st = JSON.parse(btn.dataset.mol), slot = btn.nextElementSibling;
  if (typeof PDBeMolstarPlugin === "undefined") { slot.innerHTML = '<p class="muted">3D viewer could not load (offline?). The evidence tables still work.</p>'; return; }
  slot.innerHTML = '<div class="viewer"></div>';
  viewer = new PDBeMolstarPlugin();
  viewer.render(slot.firstChild, {moleculeId: st.id.toLowerCase(), hideControls: true, hideCanvasControls: ["animation", "selection"],
    bgColor: matchMedia("(prefers-color-scheme: dark)").matches ? {r: 31, g: 31, b: 29} : {r: 255, g: 255, b: 255}});
  viewer.events.loadComplete.subscribe(() => {
    try { viewer.visual.select({data: [{auth_asym_id: st.chain, start_auth_residue_number: st.auth_resnum, end_auth_residue_number: st.auth_resnum,
      color: {r: 235, g: 104, b: 52}, sideChain: true, focus: true}], nonSelectedColor: {r: 200, g: 200, b: 195}}); } catch (e) { console.warn(e); }
  });
}
async function explainInto(btn, q, tries = 0) {
  const holder = btn.closest(".body"); btn.disabled = true; btn.textContent = "Working…";
  const qs = new URLSearchParams({pos: q.pos, ref: q.ref || "", alt: q.alt || ""});
  try {
    const c = await api(`/api/jobs/${jobId}/explain?${qs}`);
    if (c.state === "preparing" && tries < 450) { btn.textContent = "Evidence being prepared (AlphaFold + homologs; can take minutes)…"; setTimeout(() => explainInto(btn, q, tries + 1), 4000); return; }
    const tmp = document.createElement("div"); tmp.innerHTML = renderCard(c); const d = tmp.firstChild; d.open = true;
    (btn.closest("tr") ? btn.closest("tr").nextElementSibling.querySelector("td") : holder).prepend(d); wireCards(d); btn.remove();
  } catch (e) { btn.disabled = false; btn.textContent = "Retry"; btn.insertAdjacentHTML("afterend", `<span class="msg">${esc(e.message)}</span>`); }
}

// ------------------------------------------------------------------ report: drugs + variants table
let vScope = "priority", vQ = "", vOff = 0;
function wireReport(d) {
  $("#rdrugs").innerHTML = `<div class="tbl-wrap"><table class="grid"><tr><th>Drug</th><th>WHO call</th><th>Resistance-associated</th><th>Uncertain</th><th>Failed loci</th></tr>
    ${d.drug_calls.map(v => `<tr><td>${esc(v.drug)}</td><td><span class="chip ${chipFor(v.who_call)}">${esc(v.who_call)}</span></td><td>${v.resistance_variants.map(esc).join("<br>") || na}</td>
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
  if (reset) { vOff = 0; $("#vtbl").innerHTML = `<tr><th>Gene</th><th>Variant</th><th>Effect</th><th>Callers</th><th>AF</th><th>Depth</th><th>WHO</th><th>Evidence</th></tr>`; }
  const r = await api(`/api/jobs/${jobId}/variants?` + new URLSearchParams({scope: vScope, q: vQ, offset: vOff, limit: 100}));
  $("#vscope").textContent = vScope === "priority" ? "Show all variants" : "Show WHO / resistance-gene variants only";
  $("#vtbl").insertAdjacentHTML("beforeend", r.rows.map(v => {
    const od = v.evidence_state === "on demand";
    const e = od ? `<button class="small" data-explain='${esc(JSON.stringify({pos: v.pos, ref: v.ref, alt: v.alt}))}'>Explain</button>` : `${esc(v.evidence_state.replace(/_/g, " "))}${v.evidence_points ? ` · ${v.evidence_points.split(",").length} pts` : ""}`;
    return `<tr><td>${esc(v.gene)}</td><td>${esc(v.variant || v.type)}</td><td>${esc(v.effect)}</td><td>${esc(v.callers)}</td><td>${esc(v.allele_fraction)}</td><td>${esc(v.depth)}</td>
      <td>${esc(v.who_drug_grading) || na}</td><td>${e}</td></tr><tr><td colspan="8" class="xrow"></td></tr>`;
  }).join(""));
  wireCards($("#vtbl"));
  vOff += r.rows.length; $("#vcount").textContent = `${vOff} of ${r.total} shown`; $("#vmore").hidden = vOff >= r.total;
}
