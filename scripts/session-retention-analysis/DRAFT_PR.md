# What Problem This Explores

OpenClaw's cleanup planner correctly protects live/recent state and builds atomic ownership groups,
but its current ordering does not measure the recovery value of relationships among already-eligible
groups. This PR asks whether a graph-aware ranking preserves more estimated recovery value at equal
reclaim targets.

# Why This Experiment Exists

Heming Zeng's FAGR research inspired the general principle of evaluating relationships between
stored units before optimizing individual units. This is not a port, contains no copied FAGR code,
and does not claim research or algorithmic equivalence.

# Existing Safety Boundary

The prototype consumes the exact plan from `applySessionEntryMaintenance` and the exact ownership
groups used by maintenance batching. Existing active-work protection, references, recent-state
preservation, archive planning, revalidation, ownership atomicity, transactions, and retry behavior
remain authoritative.

The analyzer only ranks groups that the existing planner already considers eligible. It never
finalizes a plan and verifies a logical store fingerprint before and after analysis.

# Experimental Model

The read-only SQLite projection uses session lineage, fork source, verified `spawned_by` parent
semantics, generation chains, activity/access metadata, bounded transcript aggregates, fan-out,
descendant reach, estimated recovery cost, and estimated reclaimable bytes. It compares exact
existing order, least-recently-active, size-first, and two explainable graph-aware weight sets.

Recovery and eviction priorities derive from the same per-feature explanation. Missing metadata is
neutral, traversal is iterative, and ties are deterministic.

# Benchmark Workloads

- isolated stale bulk;
- fork fan-out;
- generation chains with current protection;
- spawn trees;
- mixed disk pressure with recent, pinned, stale, connected, isolated, and shared-owner state.

Fixtures use production storage APIs in temporary state rooted under `os.tmpdir`. Smoke, default,
and opt-in large modes cover approximately 100, 1,000, and 10,000 groups.

# Results

At default size, graph-aware ordering preserved more estimated value than existing order in fork
fan-out (58.7058 vs 52.7667), generation chains (76.7436 vs 74.7782), and mixed pressure (39.7642 vs
38.6942). It was nearly neutral on isolated bulk (80.3172 vs 80.0420) and worse on spawn trees
(58.6807 vs 61.9663). The alternate weight set preserved the same directional result.

The large run reproduced those conclusions. Every run recorded zero protected-group violations,
zero ownership-group splits, and zero store mutations.

# Computer Cost

Default analysis took 34–81 ms per workload with positive post-analysis heap deltas around 13.5–20.2
MB. The approximately 10,000-group opt-in run took 0.31–0.83 seconds per workload and observed a
maximum positive heap delta of 54.3 MB. SQL projection remained batched at 32–56 queries per large
workload. Timings are observational, not CI thresholds.

# Limitations

Recovery value and reclaimable bytes are proxies. Normalization is cohort-relative, `heapUsed` is
GC-sensitive, and synthetic relationships do not establish production prevalence. The spawn-tree
regression is evidence against promoting this formula unchanged.

# Deliberate Non-Goals

- No cleanup behavior changed.
- No user data was used.
- No schema, public configuration, protocol, Plugin SDK, CLI contract, archive format, transaction,
  or ownership-group semantics changed.
- No archive blob was read or decompressed.
- No dependencies were added.
- This is measurement-only; it is not a production policy.

# Validation

- Passed focused scoring (9 tests), SQLite projection (3 tests), and benchmark safety/determinism (2
  tests), including the 10,000-group iterative traversal case and independently created fixtures.
- Passed smoke, default, and opt-in large benchmarks with all three mutation/protection/ownership
  invariants at zero.
- Passed changed-file formatting, direct type-aware Oxlint with the repository core and scripts
  configs, session-accessor boundary, database-first, Kysely, generated Kysely types, import-cycle,
  SQLite schema-baseline, generated-report privacy, manual cleanup-boundary, and
  `git diff --cached --check` checks.
- Existing history-eviction, cleanup-race, and maintenance-writer regressions passed (31 tests).
  Parent/fork assertions all reached cleanup but Windows failed to unlink their open SQLite/SHM
  files (`EBUSY`, 10 tests). Sessions-cleanup passed 9 of 14; five existing fixtures expected POSIX
  `/resolved/...` paths but received Windows `C:\resolved\...` paths.
- The canonical combined Vitest wrapper initially timed out starting fork workers. Subsequent direct
  runs under the repository owner configs produced the focused and regression results above.
- Canonical native production/scripts TypeScript and standard TypeScript fallbacks remained silent
  for bounded 15–30-minute attempts. These are reported as incomplete, not passing; no diagnostic
  attributed a failure to a changed file.
- Repository AI autoreview was not run because this experiment's safety rules prohibit model/LLM
  inference. The staged diff received a manual safety and ownership review instead.

# AI-Assisted Disclosure

This measurement-only prototype, tests, benchmark fixtures, analysis, and draft text were prepared
with AI assistance and reviewed against repository ownership and safety rules. No model provider or
LLM inference was invoked by the benchmark or validation workflow, and no personal OpenClaw state,
session text, credential, channel, external API, or network service was used.
