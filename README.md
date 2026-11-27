# MTB ResiFiler — pipeline demonstration

Static demonstration of the **MTB ResiFiler** resistance-profiling pipeline for
*Mycobacterium tuberculosis*, shown at the SC&IS Silver Jubilee Symposium
(JNU, New Delhi, 27–28 November 2026).

> **Work in progress.** The pipeline is being built in stages. The benchmarked architecture
> described in our abstract is **not integrated here**. This is a re-implementation, **not** the
> benchmarked ResiFiler configuration: **no accuracy is claimed** and every threshold is a
> provisional placeholder.

## What this page shows

The layout follows the steps of our earlier app: **1 Pipeline Configuration**, **2 Submit New Job**, **3 Job Dashboard**
and **4 Active Job Manager**, with one tab per pipeline step, each showing that step's output.

| Tab | Output shown |
|---|---|
| 1 QC | read statistics, the QC report |
| 2 Trimming | before/after statistics, reads removed, the trimming log |
| 3 Alignment | aligner, mapping rate |
| 4 BAM QC | depth, genome coverage, depth across the resistance loci |
| 5 BAM Processing | duplicate rate (marked, not removed) |
| 6 Variant Calling | counts by type and class, a VCF preview. MTB-ResiFiler's own orchestrated caller: fixed, not selectable, method unpublished |
| 7 Annotation | effect summary, gene table, variants in catalogue genes, download |
| 8 Filtering | how the WHO profile is read, lineage |
| 9 Report | lineage, drug resistance profile, mutation landscape, CSV / HTML / JSON / TSV downloads |
| 10 AI Prediction | machine-learning MIC prediction: **in development**, not part of this run |

**The resistance call always comes from the WHO catalogue v2.** Grade 1-2 variants give resistance (fixed at an allele
fraction of 90% or more, heteroresistance below it). Grade 3 variants are listed as uncertain significance and are not
counted as resistance. Loss-of-function and deletion rules are not applied for now, so such a variant is reported
**Not assessed**, never susceptible. Low coverage at a resistance locus is reported **Fail**, never susceptible.

### Tool combination, not a tool menu

Every stage takes a tool parameter, but a tool is offered only as part of a *validated combination*: one that has been run
end to end on the test data together. Selecting a tool outside the validated set stops the run with an explicit error
rather than producing results. The variant-calling step is fixed.

## The sample output

The page shows one stored sample output: the public ENA run ERR4811184 (a rifampicin-resistant isolate), already taken
through the pipeline. Nothing is simulated and nothing is recomputed for display.

## What this page does not do

* It does not run the pipeline. Uploading a sequence and watching it run is demonstrated live at
  the poster; this page checks a file's format in your browser and shows the stored sample output.
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
