import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { applySessionEntryMaintenance } from "../../src/config/sessions/session-accessor.sqlite-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../src/config/sessions/session-sqlite-target.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import {
  BALANCED_GRAPH_WEIGHTS,
  PRIMARY_GRAPH_WEIGHTS,
  type RetentionPolicyName,
} from "./graph-aware-ranking.js";
import {
  evaluateRetentionPolicy,
  POLICY_INDEPENDENT_EVALUATION_WEIGHTS,
  type RetentionPolicyMetrics,
} from "./metrics.js";
import {
  buildRetentionOwnershipGroups,
  projectSessionRetentionGroups,
} from "./sqlite-projection.js";
import { assertIsolatedStateEnvironment, createDisposableRetentionState } from "./state-safety.js";
import { readSessionStoreFingerprint } from "./store-fingerprint.js";
import {
  populateRetentionWorkload,
  RETENTION_FIXTURE_VERSION,
  WORKLOAD_NAMES,
  type RetentionWorkloadName,
} from "./workloads.js";

export type BenchmarkMode = "smoke" | "default";

type TimedPolicyMetrics = RetentionPolicyMetrics & {
  runtimeMs: number;
  heapDeltaBytes: number;
};

type WorkloadBenchmarkResult = {
  workload: RetentionWorkloadName;
  targetBytes: number;
  inputCounts: {
    ownershipGroups: number;
    sessions: number;
    sessionEntries: number;
    transcriptEvents: number;
    sqlQueries: number;
  };
  analysisRuntimeMs: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapDeltaBytes: number;
  policies: TimedPolicyMetrics[];
  invariants: {
    protectedGroupViolations: number;
    ownershipGroupSplits: number;
    actualMutations: number;
    isolatedStateDirectory: boolean;
  };
};

export type RetentionBenchmarkReport = {
  repositoryCommit: string;
  nodeVersion: string;
  fixtureVersion: string;
  mode: BenchmarkMode;
  groupsPerWorkload: number;
  policyNames: RetentionPolicyName[];
  rankingWeightSets: [typeof PRIMARY_GRAPH_WEIGHTS, typeof BALANCED_GRAPH_WEIGHTS];
  evaluationWeightSet: typeof POLICY_INDEPENDENT_EVALUATION_WEIGHTS;
  workloads: WorkloadBenchmarkResult[];
  invariants: {
    protectedGroupViolations: number;
    ownershipGroupSplits: number;
    actualMutations: number;
  };
};

const POLICIES: RetentionPolicyName[] = [
  "existing-order",
  "least-recently-active",
  "size-first",
  "graph-aware",
  "graph-aware-balanced",
];

const GROUPS_PER_WORKLOAD: Record<BenchmarkMode, number> = {
  smoke: 20,
  default: 200,
};

const DAY_MS = 24 * 60 * 60 * 1_000;

function repositoryCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function databaseTarget(storePath: string): { agentId: string; path: string } {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  if (!target.path) {
    throw new Error("Expected a SQLite target for retention benchmark fixture");
  }
  return { agentId: target.agentId ?? "main", path: target.path };
}

function readFingerprintReadOnly(target: { agentId: string; path: string }): string {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionStoreFingerprint(database as OpenClawAgentDatabase),
    target,
  );
  if (!opened.found) {
    throw new Error(`Cannot fingerprint retention fixture: ${opened.reason}`);
  }
  return opened.value;
}

async function benchmarkWorkload(params: {
  workload: RetentionWorkloadName;
  groupsPerWorkload: number;
}): Promise<WorkloadBenchmarkResult> {
  const testState = await createDisposableRetentionState();
  try {
    assertIsolatedStateEnvironment(testState.stateDir);
    const storePath = path.join(testState.sessionsDir, "sessions.json");
    const fixture = populateRetentionWorkload({
      storePath,
      workload: params.workload,
      groupCount: params.groupsPerWorkload,
    });
    const target = databaseTarget(storePath);
    const database = openOpenClawAgentDatabase(target);
    database.walMaintenance.checkpoint();
    const fingerprintBefore = readSessionStoreFingerprint(database);
    const plan = applySessionEntryMaintenance(database, {
      activeSessionKey: "agent:main:main",
      archiveDirectory: testState.sessionsDir,
      forceMaintenance: true,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 365 * DAY_MS,
        archiveDashboardAfterMs: null,
        maxEntries: Number.MAX_SAFE_INTEGER,
        modelRunPruneAfterMs: Number.MAX_SAFE_INTEGER,
        preserveRecentMs: 7 * DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      storePath,
    });
    const fingerprintAfterPlanner = readSessionStoreFingerprint(database);
    const ownershipGroups = buildRetentionOwnershipGroups([plan]);
    const plannedKeys = new Set(
      ownershipGroups.flatMap((group) => group.entryRemovals.map((removal) => removal.sessionKey)),
    );
    const plannerProtectionViolations = fixture.protectedSessionKeys.filter((key) =>
      plannedKeys.has(key),
    ).length;
    closeOpenClawAgentDatabasesForTest();

    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const analysisStartedAt = performance.now();
    const projection = projectSessionRetentionGroups({
      database: target,
      ownershipGroups,
    });
    const policyMetrics = POLICIES.map((policy): TimedPolicyMetrics => {
      const heapBeforePolicy = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      const metrics = evaluateRetentionPolicy({
        groups: projection.groups,
        policy,
        targetBytes: Math.max(
          1,
          Math.floor(
            projection.groups.reduce((total, group) => total + group.reclaimableBytes, 0) * 0.25,
          ),
        ),
      });
      return {
        ...metrics,
        runtimeMs: Number((performance.now() - startedAt).toFixed(3)),
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBeforePolicy,
      };
    });
    const analysisRuntimeMs = Number((performance.now() - analysisStartedAt).toFixed(3));
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const fingerprintAfterAnalysis = readFingerprintReadOnly(target);
    const actualMutations =
      fingerprintBefore === fingerprintAfterPlanner &&
      fingerprintBefore === fingerprintAfterAnalysis
        ? 0
        : 1;
    const targetBytes = policyMetrics[0]?.targetBytes ?? 0;
    const protectedGroupViolations =
      plannerProtectionViolations +
      policyMetrics.reduce((total, metrics) => total + metrics.protectedGroupViolations, 0);
    const ownershipGroupSplits = policyMetrics.reduce(
      (total, metrics) => total + metrics.ownershipGroupSplits,
      0,
    );
    return {
      workload: params.workload,
      targetBytes,
      inputCounts: {
        ownershipGroups: projection.groups.length,
        sessions: projection.groups.reduce((total, group) => total + group.sessionIds.length, 0),
        sessionEntries: fixture.sessionEntriesCreated,
        transcriptEvents: fixture.transcriptEventsCreated,
        sqlQueries: projection.queryCount,
      },
      analysisRuntimeMs,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      policies: policyMetrics,
      invariants: {
        protectedGroupViolations,
        ownershipGroupSplits,
        actualMutations,
        isolatedStateDirectory: true,
      },
    };
  } finally {
    try {
      closeOpenClawAgentDatabasesForTest();
    } finally {
      await testState.cleanup();
    }
  }
}

function printComparisonTable(report: RetentionBenchmarkReport): void {
  const header = [
    "Workload".padEnd(24),
    "Policy".padEnd(25),
    "Bytes selected".padStart(14),
    "Independent value".padStart(17),
    "Runtime ms".padStart(10),
    "Heap delta".padStart(12),
  ].join("  ");
  console.log(header);
  for (const workload of report.workloads) {
    for (const policy of workload.policies) {
      console.log(
        [
          workload.workload.padEnd(24),
          policy.policy.padEnd(25),
          String(policy.actualBytesSelected).padStart(14),
          policy.policyIndependentValuePreserved.toFixed(4).padStart(17),
          policy.runtimeMs.toFixed(3).padStart(10),
          String(policy.heapDeltaBytes).padStart(12),
        ].join("  "),
      );
    }
  }
}

export async function runRetentionBenchmark(params: {
  mode: BenchmarkMode;
  groupsPerWorkload?: number;
  writeArtifact?: boolean;
}): Promise<RetentionBenchmarkReport> {
  const groupsPerWorkload = params.groupsPerWorkload ?? GROUPS_PER_WORKLOAD[params.mode];
  const workloads: WorkloadBenchmarkResult[] = [];
  for (const workload of WORKLOAD_NAMES) {
    workloads.push(await benchmarkWorkload({ workload, groupsPerWorkload }));
  }
  const report: RetentionBenchmarkReport = {
    repositoryCommit: repositoryCommit(),
    nodeVersion: process.version,
    fixtureVersion: RETENTION_FIXTURE_VERSION,
    mode: params.mode,
    groupsPerWorkload,
    policyNames: POLICIES,
    rankingWeightSets: [PRIMARY_GRAPH_WEIGHTS, BALANCED_GRAPH_WEIGHTS],
    evaluationWeightSet: POLICY_INDEPENDENT_EVALUATION_WEIGHTS,
    workloads,
    invariants: {
      protectedGroupViolations: workloads.reduce(
        (total, workload) => total + workload.invariants.protectedGroupViolations,
        0,
      ),
      ownershipGroupSplits: workloads.reduce(
        (total, workload) => total + workload.invariants.ownershipGroupSplits,
        0,
      ),
      actualMutations: workloads.reduce(
        (total, workload) => total + workload.invariants.actualMutations,
        0,
      ),
    },
  };
  if (params.writeArtifact !== false) {
    const artifactDirectory = path.join(process.cwd(), ".artifacts", "session-retention-analysis");
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.writeFile(
      path.join(artifactDirectory, `${params.mode}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }
  printComparisonTable(report);
  if (
    report.invariants.protectedGroupViolations !== 0 ||
    report.invariants.ownershipGroupSplits !== 0 ||
    report.invariants.actualMutations !== 0
  ) {
    throw new Error("Session retention benchmark invariant violation");
  }
  return report;
}

function parseMode(argv: readonly string[]): BenchmarkMode {
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "default";
  if (mode !== "smoke" && mode !== "default") {
    throw new Error(`Unknown benchmark mode: ${mode ?? "<missing>"}`);
  }
  return mode;
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  await runRetentionBenchmark({ mode: parseMode(process.argv.slice(2)) });
}
