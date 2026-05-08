# ADR: Vector Search Scaling Strategy

**Date:** 2026-05-08  
**Status:** Accepted  
**Issue:** #96

---

## Context

Claudeye uses hybrid FTS5 + vector search (cosine similarity in JS) for context injection.
As of 2026-05-08: **15,148 embeddings**, **~88.8 MB** of vector data across all projects.

The top project (`astrosphere`) has 10,385 embeddings — 68.5% of all vectors.

### Current architecture

`getObservationsWithEmbeddings(project, limit=300)` loads at most **350 rows** per query:
- Up to 300 non-git-commit observations (project-scoped `WHERE o.project = ?`)
- Up to 50 git-commit observations (capped via `GIT_CAP=50`)

JS cosine similarity is O(n) over the loaded rows, not over the full DB.

---

## Benchmark results (2026-05-08, 15k embeddings)

| Project | Rows loaded | DB load | JS compute | Total |
|---|---|---|---|---|
| astrosphere (10,385 emb) | 300 | 2.6 ms | 1.9 ms | **4.5 ms** |
| entravel-fe (1,376 emb) | 318 | 1.8 ms | 0.5 ms | **2.4 ms** |
| entravel-rn (769 emb) | 350 | 2.6 ms | 0.5 ms | **3.1 ms** |
| claudeye (607 emb) | 300 | 2.2 ms | 0.4 ms | **2.6 ms** |

Key insight: **query time is determined by the LIMIT (300-350 rows), not by total embeddings in DB**.
Even for astrosphere with 10k+ embeddings, only 300 rows are loaded per query.

---

## Decision: sqlite-vec NOT adopted at this stage

### Options considered

**Option A — Keep current JS cosine similarity (chosen)**

- Pro: sub-5ms per query, no native extension dependency
- Pro: bounded O(limit) not O(total_embeddings) — scales linearly with LIMIT, not DB size
- Pro: exact similarity (no ANN approximation errors, Recall@10 = 1.0)
- Pro: zero dependency surface (no FFI, works cross-platform)
- Con: at 100k+ embeddings the 300-row cap may need tuning

**Option B — sqlite-vec (HNSW)**

- Pro: sub-linear query time via Approximate Nearest Neighbor
- Pro: vector index lives in SQLite, same file
- Con: native extension (`.so` / `.dylib`) — install friction, breaking on macOS upgrades
- Con: ANN loses exact recall (typically 0.95–0.98 @ k=10)
- Con: maintenance overhead: index rebuild on bulk insert/delete
- Con: **not needed at current or projected scale** (see analysis below)

### Scale analysis

At current growth (~180 obs/day, ~60% embedding coverage):
- Embeddings grow ~108/day
- At this rate: 50k total embeddings in ~324 days (Q1 2027)

At 50k total embeddings, per-project query still loads ≤350 rows.
The 300-row LIMIT is the binding constraint, not total embeddings.

sqlite-vec becomes relevant only if we:
1. Remove the per-query LIMIT (to scan all project embeddings), AND
2. A project has >10k embeddings AND query time exceeds 50ms acceptable latency

That threshold is ≥ Q4 2027 given current growth. The bottleneck will be DB size (storage), not search speed.

### What actually controls performance

| Lever | Current | At 3× growth (45k emb) |
|---|---|---|
| Rows per query | 300-350 | 300-350 (unchanged) |
| Total query time | < 5 ms | < 5 ms (stable) |
| DB size (embeddings) | 88.8 MB | ~267 MB |

The `embedding_retention_days` tiered compact (implemented in #96) controls DB size:
- importance < 0.5, older than 7 days → vector pruned
- importance 0.5–0.8, older than 90 days → vector pruned

---

## Implemented improvements (shipped, #96)

1. **Project-scoped SQL filter** — `WHERE o.project = ?` in `getObservationsWithEmbeddings()`. Prevents loading cross-project embeddings for in-project queries.
2. **Tiered embedding retention** — `embedding_retention_days` + `embedding_retention_days_high` in `compact()`. Configurable via `~/.claudeye/settings.json`.
3. **Git-commit cap** — `GIT_CAP=50` per project. Prevents bulk git import from dominating vector results.

---

## Re-evaluate sqlite-vec when

- Single project exceeds 20k embeddings AND query time > 20ms
- OR total DB size exceeds 500MB and tiered retention can't control it
- OR multiple concurrent users need sub-ms p99 (current: single-user CLI)
