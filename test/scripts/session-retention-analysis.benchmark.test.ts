import { expect, it } from "vitest";
import { runRetentionBenchmark } from "../../scripts/session-retention-analysis/benchmark.js";

function deterministicMetrics(report: Awaited<ReturnType<typeof runRetentionBenchmark>>) {
  return report.workloads.map((workload) => ({
    workload: workload.workload,
    targetBytes: workload.targetBytes,
    inputCounts: workload.inputCounts,
    policies: workload.policies.map(
      ({ runtimeMs: _runtimeMs, heapDeltaBytes: _heapDelta, ...policy }) => policy,
    ),
    invariants: workload.invariants,
  }));
}

it("runs every temporary-store workload without mutations, splits, or protection violations", async () => {
  const report = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });

  expect(report.workloads).toHaveLength(5);
  expect(report.invariants).toEqual({
    protectedGroupViolations: 0,
    ownershipGroupSplits: 0,
    actualMutations: 0,
  });
  expect(report.workloads.every((workload) => workload.invariants.isolatedStateDirectory)).toBe(
    true,
  );
  expect(JSON.stringify(report)).not.toMatch(/[A-Z]:\\Users\\/u);
});

it("produces identical policy metrics from independently created fixtures", async () => {
  const first = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });
  const second = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });

  expect(deterministicMetrics(second)).toEqual(deterministicMetrics(first));
});
