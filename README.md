# MTB ResiFiler — pipeline demonstration

Static demonstration of the **MTB ResiFiler** resistance-profiling pipeline for
*Mycobacterium tuberculosis*, shown at the SC&IS Silver Jubilee Symposium
(JNU, New Delhi, 27–28 November 2026).

> **Work in progress.** The pipeline is being built in stages. The benchmarked architecture
> described in our abstract is **not integrated here**. This is a re-implementation, **not** the
> benchmarked ResiFiler configuration: **no accuracy is claimed** and every threshold is a
> provisional placeholder.

## What this page shows

Five publicly available *M. tuberculosis* Illumina runs from ENA, already taken through the
pipeline. For each isolate you can step through what every stage produced:

| Stage | Tool |
|---|---|
| 1 Upload and validation | in-browser format check |
| 2 QC and species / contamination check | fastp, Mash screen |
| 3 Trimming | fastp |
| 4 Alignment and coverage | BWA-MEM, samtools markdup, mosdepth |
| 5 Variant calling | MTB-ResiFiler's own orchestrated caller (fixed, not selectable; method unpublished) |
| 6 Annotation and numbering | SnpEff, checked against the WHO catalogue's genomic coordinates |
| 7 WHO catalogue v2 lookup per drug | loss-of-function and deletion rules; low coverage reports Fail, never susceptible |
| 8 Report | JSON and TSV download |

**MIC prediction (machine learning) is in development** and is not part of this run.

**The resistance call always comes from the WHO catalogue v2.**

### Tool chain, not a tool menu

Every stage takes a tool parameter, but a tool is offered only as part of a *validated chain*: a
preset is a combination that has been run end to end on the test data together. Selecting a tool
outside the validated set stops the run with an explicit error rather than producing results, and
any deviation is printed at the top of the report. One preset (`Standard`) ships today.

## Isolates

| ENA run | Why it is in the test set |
|---|---|
| ERR4811184 | Rifampicin-resistant, rpoB S450L |
| ERR4810953 | pncA frameshift (loss of function) |
| ERR4810628 | katG frameshift (loss of function) |
| ERR3287702 | Large deletion spanning pncA |
| ERR4811099 | Pan-susceptible control |

Expected genotypes come from the CRyPTIC consortium (release_june2022) and are used only as an
external reference, never for tuning.

## The variant caller

Variant calling is MTB-ResiFiler's exclusive orchestrated caller. It is shown as a fixed step with its
output (what was called, and the class of each call) but is not selectable and its method is not
described, because it is unpublished work.

## What this page does not do

* It does not run the pipeline. Uploading a sequence and watching it run is demonstrated live at
  the poster; this page shows stored results.
* No machine-learning predictor and no MIC prediction are included; both are in development.
* No patient data. Every isolate is a public ENA run; no sequence reads are published here.

## Reproducibility

These JSON files are the pipeline's own stage outputs, exported by `scripts/build_demo.py` in the
pipeline repository. Nothing is simulated and nothing is recomputed for display.

## Sources

WHO catalogue of mutations v2 (WHO-UCN-TB-2023.6) · *M. tuberculosis* H37Rv NC_000962.3 (NCBI) ·
UniProt · PDB 5UHC, 3PL1, 1SJ2, 7BVF, 5BS8 · AlphaFold DB · InterPro/Pfam · TnSeq essentiality
(DeJesus et al. 2017) · UniProtKB/Swiss-Prot. 3D structures are rendered with Mol* (PDBe build).

## Authors

Divyangana Bathla, Sougata Jana and Shandar Ahmad.
School of Computational and Integrative Sciences, Jawaharlal Nehru University, New Delhi.
