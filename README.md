# Hippocampus — Enterprise Hybrid RAG & Agentic Onboarding System

[![Research Report](https://img.shields.io/badge/Technical_Paper-HIPPOCAMPUS__RESEARCH__REPORT.md-4f46e5?style=for-the-badge)](./docs/research/HIPPOCAMPUS_RESEARCH_REPORT.md)
[![IEEE LaTeX Manuscript](https://img.shields.io/badge/IEEE_LaTeX-hippocampus__ieee__paper.tex-0f766e?style=for-the-badge)](./docs/research/hippocampus_ieee_paper.tex)
[![IEEE PDF Target](https://img.shields.io/badge/IEEE_PDF-hippocampus__ieee__paper.pdf-b91c1c?style=for-the-badge)](./docs/research/hippocampus_ieee_paper.pdf)
[![Empirical Results](https://img.shields.io/badge/Benchmarks-results.json_%7C_ablation__table.csv-1d4ed8?style=for-the-badge)](./benchmarks/results.json)

> **Research Study:** *Hybrid Lexical-Dense Retrieval with Role-Constrained Context Gating in Enterprise Knowledge Systems (Hippocampus)*  
> **Author:** **Aniket Kumar Choudhary** — Department of Artificial Intelligence & Data Science, Indian Institute of Technology (IIT) Jodhpur (`aniketkumarchoudhary629@gmail.com` | GitHub: [`Uchiha7madara-afk`](https://github.com/Uchiha7madara-afk))  
> **Quick Links:** [2-Page Technical Research Paper (Markdown)](./docs/research/HIPPOCAMPUS_RESEARCH_REPORT.md) · [2-Column IEEEtran Manuscript (`.tex`)](./docs/research/hippocampus_ieee_paper.tex) · [Evaluation Dataset (`52` Docs / `50` Queries)](./benchmarks/eval_dataset.json) · [Ablation Runner (`run_ablation.ts`)](./benchmarks/run_ablation.ts)

---

## Key Empirical Benchmarks (`N = 52` Enterprise Docs, `50` Ground-Truth Queries)

All metrics below are measured directly against our retrieval pipeline (`src/db/queries.ts` & `src/lib/ai.ts`) and exported to [`./benchmarks/results.json`](./benchmarks/results.json) and [`./benchmarks/ablation_table.csv`](./benchmarks/ablation_table.csv).

### 1. Retrieval Regime Ablation (`W = 512, O = 100` Sliding-Window Segmentation, `56` Indexed Chunks)

| Retrieval Mode | Exact-Match Recall@5 (%) | Conceptual Recall@5 (%) | Overall Recall@3 (%) | Overall Recall@5 (%) | MRR@5 | OOD Hallucination Rate (%) | RBAC Leakage Rate (%) | P50 Retrieval (ms) | P95 Retrieval (ms) | E2E Synthesis (s) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `sparse_bm25` (Okapi BM25 Only) | **100.0%** | 75.0% | 85.0% | 87.5% | 0.831 | 100.0% | **0.0%** | **24.02 ms** | **29.80 ms** | 1.22 s |
| `dense_vector` (Dense Cosine Only) | 60.0% | **100.0%** | 75.0% | 80.0% | 0.665 | 100.0% | **0.0%** | 30.04 ms | 40.39 ms | 1.23 s |
| `linear_sum` (Min-Max Linear $\alpha=0.65$) | 90.0% | **100.0%** | 90.0% | 95.0% | 0.850 | 100.0% | **0.0%** | 33.70 ms | 42.45 ms | 1.23 s |
| **`hybrid_rrf` (Weighted RRF + $\tau_{\text{conf}}$ Gate)** | **100.0%** | **100.0%** | **100.0%** | **100.0%** | **0.917** | **0.0%** | **0.0%** | 33.37 ms | 38.42 ms | **1.10 s** |

### 2. Chunking Granularity Ablation (`hybrid_rrf` with $\alpha = 0.65, k = 60, \tau_{\text{conf}} = 0.26$)

| Chunking Config ($W / O$) | Indexed Chunks ($N$) | Exact-Match Recall@5 (%) | Conceptual Recall@5 (%) | Overall Recall@5 (%) | MRR@5 | OOD Hallucination Rate (%) | RBAC Leakage Rate (%) | P50 Retrieval (ms) | P95 Retrieval (ms) | E2E Synthesis (s) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`256 / 50`** (Fine) | 105 | **100.0%** | **100.0%** | **100.0%** | 0.871 | **0.0%** | **0.0%** | 41.87 ms | 49.49 ms | **0.97 s** |
| **`512 / 100`** (Canonical) | 56 | **100.0%** | **100.0%** | **100.0%** | 0.917 | **0.0%** | **0.0%** | 33.37 ms | **38.42 ms** | 1.10 s |
| **`1024 / 200`** (Coarse) | 52 | **100.0%** | **100.0%** | **100.0%** | **0.925** | **0.0%** | **0.0%** | **32.28 ms** | 46.39 ms | 1.29 s |

---

## Single-Command Benchmark Reproduction

Any reviewer can reproduce the complete $4 \times 3$ ablation study ($4$ retrieval modes $\times$ $3$ chunking granularities $\times$ $50$ queries $= 600$ evaluated query executions) and regenerate `./benchmarks/results.json` and `./benchmarks/ablation_table.csv` with a single command:

```bash
npm run benchmark
```

Under the hood, `npm run benchmark` executes `tsx benchmarks/run_ablation.ts`, which:
1. Loads the 52-document enterprise corpus and 50 ground-truth queries from [`./benchmarks/eval_dataset.json`](./benchmarks/eval_dataset.json) ($20$ Exact-Match, $20$ Conceptual Paraphrase, $5$ Out-of-Domain Adversarial, and $5$ Cross-Role RBAC Adversarial queries).
2. Segments and embeds the corpus across `256/50` ($105$ chunks), `512/100` ($56$ chunks), and `1024/200` ($52$ chunks).
3. Evaluates `sparse_bm25`, `dense_vector`, `linear_sum`, and `hybrid_rrf` via `rankCandidateChunks()` in [`src/db/queries.ts`](./src/db/queries.ts), streaming structured JSON telemetry through Pino v10 (`src/lib/logger.ts`).
4. Writes full experimental outputs to [`./benchmarks/results.json`](./benchmarks/results.json) and [`./benchmarks/ablation_table.csv`](./benchmarks/ablation_table.csv).

---

## System Overview & Core Capabilities

**Hippocampus** is an enterprise-grade AI Knowledge & Engineering Onboarding Platform built with **React 19 + Vite**, **Express + TypeScript**, **PostgreSQL + Drizzle ORM + `pgvector`**, **Google Gemini (`gemini-embedding-2` & `gemini-3.8-flash`)**, and **Pino v10 structured telemetry**:

1. **Hybrid Reciprocal Rank Fusion (`hybrid_rrf`) & 4-Mode Ablation Engine (`src/db/queries.ts`)**:
   - Combines dense cosine similarity (`gemini-embedding-2` / 64-dim latent subspace + signed feature-hashing fallback) with Okapi BM25 ($k_1 = 1.5, b = 0.75$) and exact technical identifier boosting via Weighted Reciprocal Rank Fusion:
     $$\text{RRF}(q, c) = \frac{\alpha}{60 + \text{rank}_{\text{dense}}(q, c)} + \frac{1 - \alpha}{60 + \text{rank}_{\text{bm25}}(q, c)}, \quad \alpha = 0.65$$
   - Enforces an evidence-calibrated confidence abstention gate ($\tau_{\text{conf}} = 0.26$) that eliminates out-of-domain hallucinations ($0.0\%$ OOD false-positive rate).
2. **Pre-Retrieval Role-Based Access Control (RBAC) Isolation**:
   - Enforces a strict privilege lattice ($\text{Engineer} \prec \text{Manager} \prec \text{Admin}$) prior to candidate scoring ($\mathcal{C}_{\text{adm}}(r_u)$), guaranteeing $0.0\%$ cross-role document or query-log leakage.
3. **Agentic Gemini Function Calling (`src/lib/ai.ts`)**:
   - Equips `gemini-3.8-flash` with four live operational tools: `fetchJiraTicket`, `inspectGithubPullRequest`, `pingOnCallEngineer`, and `checkServiceHealth`.
4. **Interactive Onboarding Checklists & Manager Cohort Governance (`src/components/OnboardingPanel.tsx`)**:
   - PostgreSQL-backed `onboarding_tracks` and `user_progress` tables mapping Day 1, Week 1, and Month 1 engineering milestones with one-click RAG verification prompts and Manager cohort progress tracking.
5. **Live External Knowledge Connectors (`src/lib/connectors.ts`, `src/components/ConnectorsPanel.tsx`)**:
   - **GitHub Repository & Webhook Connector:** Syncs Markdown runbooks from GitHub repositories and processes HMAC-SHA256 verified `push` events (`POST /api/webhooks/github`) on `refs/heads/main`.
   - **Google Workspace Drive & Docs Connector:** Uses Google OAuth (`drive.readonly`, `documents.readonly`) to convert Google Docs structural JSON paragraphs, headings, and tables into clean Markdown and index them into `document_chunks`.
6. **Pino v10 Structured Observability (`src/lib/logger.ts`, `src/components/TelemetryModal.tsx`)**:
   - Captures real-time JSON logs, latency percentiles, semantic cache hit rates, and Gemini token counters in a 120-event ring buffer.

---

## Quick Start & Development Scripts

```bash
# Install dependencies
npm install

# Start full-stack Express + Vite development server on port 3000
npm run dev

# Run the automated 4x3 empirical RAG & RBAC ablation benchmark suite
npm run benchmark

# Type-check and build for production
npm run lint
npm run build
```
