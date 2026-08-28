---
title: "Graph-aware session retention experiment"
summary: "A measurement-only benchmark comparing session cleanup ordering policies."
read_when:
  - Evaluating changes to session cleanup ordering
  - Reproducing the graph-aware retention benchmark
---

# Graph-aware session retention experiment

## Problem statement

OpenClaw's session maintenance already owns cleanup eligibility, protection, archive planning,
snapshot validation, retries, and the atomic grouping of state that shares an owner. Its current
candidate order does not try to estimate how relationships between eligible sessions affect later
recovery value.

This measurement-only prototype asks whether ranking the cleanup planner's already-eligible
ownership groups with lineage, access, generation, fan-out, transcript, and size metadata can
preserve more estimated recovery value at the same reclaim target.

The experiment is inspired by a relationship-aware principle described in Heming Zeng's FAGR
research: evaluate relationships between stored units before optimizing individual units. It is
not a port of FAGR, uses no FAGR code, and makes no claim of algorithmic or research equivalence.

## Existing safety boundary

The experiment starts after OpenClaw's existing authorities have completed their work:

1. `applySessionEntryMaintenance` applies the canonical active-work, live-reference, recent-entry,
   and other protection rules and produces a maintenance plan.
2. `buildSessionMaintenanceOwnershipGroups` applies the same union-find ownership grouping used by
   maintenance batching. A group is indivisible.
3. The read-only projection loads metadata only for those groups.
4. Experimental policies rank and explain those eligible groups for comparison. They never commit
   or finalize the maintenance plan.

The prototype does not change cleanup ordering, mutations, archive behavior, schema, configuration,
protocols, transactions, or ownership semantics. The production change is a behavior-preserving
export of the existing ownership-group constructor so the benchmark consumes the canonical owner
instead of reproducing it.

## Hypothesis

At a fixed byte-reclamation target, a relationship-aware eviction ordering will preserve more
estimated recovery value than current planner order in workloads with meaningful forks,
generations, or mixed disk pressure. It should be neutral in unconnected workloads and should not
require schema changes or large in-memory event graphs.

This is an experimental hypothesis. Recovery value is a proxy, not observed user recovery success.

## Model and feature definitions

The ranking unit is an existing cleanup ownership group. The SQLite adapter projects session nodes,
generation windows, and bounded transcript aggregates; it never projects transcript event JSON or
archive blobs into JavaScript.

The model uses:

- activity recency: latest valid activity, interaction, or update timestamp;
- access recency: latest valid read or interaction timestamp;
- lineage centrality: count of parent, child, previous-generation, and fork-source group edges;
- direct fan-out: direct child count plus fork fan-out;
- descendant reach: iterative, cycle-safe traversal of child group edges;
- generation continuity: generation count plus `previous_session_id` link count;
- transcript evidence: `log1p(event count) + log1p(parent-linked event count)`;
- estimated recovery cost: a bounded logarithmic combination of event count, reclaimable bytes,
  and generation count;
- estimated reclaimable bytes: SQL-aggregated `SUM(LENGTH(event_json))` plus bounded node, window,
  and event metadata estimates.

Recency comes from session-node timestamps. Generation-window timestamps are lifecycle-write times
and are deliberately excluded from the synthetic recency signal; windows contribute topology and
generation counts instead. This keeps independently created benchmark fixtures deterministic.

`spawned_by` is treated as a parent edge only because its current repository semantics identify the
requesting/spawning session. Fork source fields remain separate edges.

Missing timestamps receive a neutral normalized value of `0.5`; invalid numeric inputs become zero.
Scores are rounded to a fixed precision, contain no random input, and use planner order, then
`updated_at`, then group ID as stable tie-breakers. Least-recently-active falls back in this order:
`last_activity_at`, `last_interaction_at`, `last_read_at`, `updated_at`; a fully missing timestamp is
sorted after known timestamps.

## Policies and formula

The benchmark compares:

- **existing-order:** the exact canonical planner/ownership-group order;
- **least-recently-active:** the documented timestamp fallback, oldest known first;
- **size-first:** estimated reclaimable bytes, largest first;
- **graph-aware:** relationship-forward weights;
- **graph-aware-balanced:** an alternate, more recency-oriented sensitivity set.

The primary internal weights sum to 1.0:

| Feature               | Primary | Alternate |
| --------------------- | ------: | --------: |
| Activity recency      |    0.20 |      0.28 |
| Access recency        |    0.10 |      0.16 |
| Lineage centrality    |    0.14 |      0.10 |
| Direct fan-out        |    0.16 |      0.10 |
| Descendant reach      |    0.16 |      0.10 |
| Generation continuity |    0.14 |      0.14 |
| Transcript evidence   |    0.10 |      0.12 |

For each feature `f`, the explanation records raw value, cohort-normalized value, weight, and
`normalized(f) * weight(f)`. Their sum is `recoveryValue`.

```text
estimatedRecoveryCost = max(1,
  1 + log1p(eventCount) + log1p(reclaimableBytes) / 8 + log1p(generationCount))

recoveryPriority = recoveryValue / estimatedRecoveryCost
evictionPriority = normalizedReclaimableBytes / (0.05 + recoveryValue)
```

Eviction sorts descending by eviction priority. Recovery sorts descending by recovery priority from
the same explained score; it is not a second hidden heuristic. The formula is deliberately internal
and is not public configuration.

## Workloads and failure models

All fixtures use production session writers against disposable SQLite stores created by
`createOpenClawTestState`, which uses `fs.mkdtemp`, `os.tmpdir`, and an isolated
`OPENCLAW_STATE_DIR`. State is removed in `finally` blocks.

- **A — isolated stale bulk:** independent old sessions with varied bounded transcript sizes;
- **B — fork fan-out:** fork sources and descendants mixed with similarly old isolated sessions;
- **C — generation chain:** linked current and historical windows, with current protection left to
  the canonical planner;
- **D — spawn tree:** parent/subagent relationships using verified `spawned_by` semantics;
- **E — mixed disk pressure:** small connected groups, large isolated groups, recent and pinned
  entries, stale history, and shared multi-session ownership groups.

Smoke uses about 100 groups, default about 1,000, and the opt-in large run about 10,000 across the
five workloads. The large mode requires `OPENCLAW_SESSION_RETENTION_LARGE=1`.

## Run the benchmark

Run the supported package command from the repository root. Each mode writes a machine-readable
report to `.artifacts/session-retention-analysis/<mode>.json` and exits nonzero if it observes a
protected-group violation, ownership-group split, or store mutation.

```bash
pnpm sessions:retention:benchmark --mode smoke
pnpm sessions:retention:benchmark --mode default
OPENCLAW_SESSION_RETENTION_LARGE=1 pnpm sessions:retention:benchmark --mode large
```

Large mode is deliberately opt-in because it constructs about 10,000 groups through production
storage APIs before running the read-only analysis.

## Default benchmark results

The table is from one representative Node 24.15.0 run. Each policy selects whole ownership groups
until it meets the same per-workload target (25% of estimated eligible bytes). Runtime and heap
measurements are observational, not CI thresholds, and are expected to vary in later proof artifacts.

| Workload         | Policy               | Bytes selected | Value preserved | Runtime (ms) | Heap delta (bytes) |
| ---------------- | -------------------- | -------------: | --------------: | -----------: | -----------------: |
| isolated         | existing             |         89,049 |         80.0420 |       11.063 |          3,607,616 |
| isolated         | LRA                  |         89,049 |         80.0420 |       13.540 |          3,446,528 |
| isolated         | size-first           |         88,254 |         79.1059 |       14.402 |          3,345,528 |
| isolated         | graph-aware          |         89,057 |         80.3172 |        8.905 |          3,358,704 |
| isolated         | graph-aware-balanced |         88,193 |         80.9629 |        5.096 |          3,302,752 |
| fork fan-out     | existing             |         79,537 |         52.7667 |       10.414 |          3,323,832 |
| fork fan-out     | LRA                  |         78,990 |         57.0670 |        5.290 |          3,287,384 |
| fork fan-out     | size-first           |         80,475 |         56.9628 |        9.758 |          3,239,888 |
| fork fan-out     | graph-aware          |         79,387 |         58.7058 |        7.505 |        -62,298,256 |
| fork fan-out     | graph-aware-balanced |         80,770 |         58.7494 |        7.999 |          2,845,096 |
| generation chain | existing             |        125,770 |         74.7782 |        8.367 |          3,246,136 |
| generation chain | LRA                  |        125,770 |         74.7782 |        4.703 |          3,244,304 |
| generation chain | size-first           |        125,652 |         76.2290 |        4.724 |          3,235,912 |
| generation chain | graph-aware          |        127,408 |         76.7436 |        8.652 |          3,252,264 |
| generation chain | graph-aware-balanced |        127,088 |         76.8019 |        4.493 |          3,252,544 |
| spawn tree       | existing             |         73,389 |         61.9663 |        4.134 |          3,213,840 |
| spawn tree       | LRA                  |         74,113 |         66.2453 |        4.226 |          3,236,976 |
| spawn tree       | size-first           |         72,816 |         58.6584 |        7.965 |          3,215,968 |
| spawn tree       | graph-aware          |         72,816 |         58.6807 |        4.512 |          3,218,680 |
| spawn tree       | graph-aware-balanced |         72,816 |         58.6807 |        4.032 |          3,209,264 |
| mixed pressure   | existing             |         84,467 |         38.6942 |        2.918 |          2,177,392 |
| mixed pressure   | LRA                  |         83,770 |         35.7634 |        3.039 |          2,194,672 |
| mixed pressure   | size-first           |         83,701 |         37.3038 |        2.808 |          2,179,928 |
| mixed pressure   | graph-aware          |         83,826 |         39.7642 |        7.574 |          2,197,160 |
| mixed pressure   | graph-aware-balanced |         83,806 |         39.6980 |        2.930 |          2,188,560 |

Negative heap deltas reflect garbage collection between `heapUsed` observations, not negative memory
allocation.

## Computer cost and large-run observations

Default projection plus all five policy evaluations completed in tens of milliseconds per workload.
Positive post-analysis heap deltas were in the tens of megabytes; garbage collection made one
workload delta negative.
Each 200-group workload used four SQL queries, except generation chains (seven); mixed pressure
projected 140 eligible groups from 220 sessions in four queries.

The opt-in large run projected 9,400 eligible ownership groups, 12,200 sessions, and 37,409 bounded
events across all workloads. Per-workload analysis remained under one second, and the largest
observed positive post-analysis heap delta remained under 60 MB. Query counts stayed bounded at
32–56 per workload. Fixture construction through production writers is intentionally excluded from
analysis timing and was slower than the read-only analysis.

Large-run outcomes reproduced the direction of the default evidence: graph-aware preserved 589.2142
versus 527.7995 for existing order on fork fan-out, 771.8542 versus 749.4733 on generation chains,
and 399.8150 versus 389.8574 on mixed pressure. It remained worse on spawn trees (587.1976 versus
620.4919) and nearly neutral on isolated bulk (806.7204 versus 804.2731). The alternate weights
produced the same directional conclusions.

All smoke, default, and large reports recorded zero protected-group violations, zero ownership-group
splits, and zero store mutations. Generated JSON is written under the ignored
`.artifacts/session-retention-analysis/` directory and includes the repository commit, Node version,
fixture version, policies, weight sets, input counts, outputs, timings, and invariants.

## Limitations

- Recovery value is an explainable estimate, not an observed recovery outcome.
- Cohort min/max normalization makes scores comparative within one cleanup plan.
- Estimated reclaimable bytes include metadata constants rather than exact SQLite page recovery.
- Descendant traversal is iterative and safe at 10,000 groups, but worst-case dense graphs need
  further complexity measurement.
- Post-analysis `heapUsed` deltas are sensitive to garbage collection and are not peak RSS.
- The spawn-tree loss shows that the eviction formula can overvalue byte yield relative to connected
  structure; the feature model should not be promoted unchanged.
- Synthetic workloads exercise production storage APIs but cannot establish real-world prevalence or
  user value.

## Decision and proposed next step

The evidence supports a narrow follow-up because two reasonable weight sets improve relationship-
heavy fork, generation, and mixed workloads without schema changes or safety violations. It does not
support changing production cleanup order: the spawn-tree regression, proxy outcome, and large-run
cost require more evidence.

The next step should be a maintainer RFC or opt-in dry-run explanation that samples anonymized
aggregate shapes and validates the proxy against recovery tasks. A recovery-ordering or disk-budget
ranking experiment could follow only after that review. No public CLI, configuration, or cleanup
mutation change belongs in this prototype.
