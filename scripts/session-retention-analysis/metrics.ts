import {
  PRIMARY_GRAPH_WEIGHTS,
  rankRetentionGroups,
  rankRetentionGroupsForRecovery,
  scoreGraphAwareGroups,
  selectGroupsToByteTarget,
  type RetentionPolicyName,
  type SessionRetentionGroup,
} from "./graph-aware-ranking.js";

export type RecoveryCurve = {
  first10Percent: number;
  first25Percent: number;
  first50Percent: number;
};

export type RetentionPolicyMetrics = {
  policy: RetentionPolicyName;
  targetBytes: number;
  actualBytesSelected: number;
  ownershipGroupsSelected: number;
  sessionsSelected: number;
  estimatedRecoveryValuePreserved: number;
  dependencyWeightedValuePreserved: number;
  highValueGroupsPreserved: number;
  recoveryValueByCost: RecoveryCurve;
  protectedGroupViolations: number;
  ownershipGroupSplits: number;
  selectedGroupIds: string[];
};

const METRIC_PRECISION = 9;

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(METRIC_PRECISION)) : 0;
}

function recoveryCurve(groups: readonly SessionRetentionGroup[]): RecoveryCurve {
  const ranking = rankRetentionGroupsForRecovery({
    groups,
    weightSet: PRIMARY_GRAPH_WEIGHTS,
  });
  const totalCost = ranking.reduce(
    (total, ranked) => total + ranked.score.estimatedRecoveryCost,
    0,
  );
  const valueAtFraction = (fraction: number): number => {
    const budget = totalCost * fraction;
    let spent = 0;
    let value = 0;
    for (const ranked of ranking) {
      if (spent + ranked.score.estimatedRecoveryCost > budget) {
        break;
      }
      spent += ranked.score.estimatedRecoveryCost;
      value += ranked.score.recoveryValue;
    }
    return roundMetric(value);
  };
  return {
    first10Percent: valueAtFraction(0.1),
    first25Percent: valueAtFraction(0.25),
    first50Percent: valueAtFraction(0.5),
  };
}

export function evaluateRetentionPolicy(params: {
  groups: readonly SessionRetentionGroup[];
  policy: RetentionPolicyName;
  targetBytes: number;
  protectedGroupIds?: ReadonlySet<string>;
}): RetentionPolicyMetrics {
  const ranking = rankRetentionGroups({ groups: params.groups, policy: params.policy });
  const selected = selectGroupsToByteTarget(ranking, params.targetBytes);
  const selectedGroupIds = new Set(selected.map((ranked) => ranked.group.groupId));
  const primaryScores = scoreGraphAwareGroups(params.groups, PRIMARY_GRAPH_WEIGHTS);
  const availableGroups = params.groups.filter((group) => !group.protected);
  const totalRecoveryValue = availableGroups.reduce(
    (total, group) => total + (primaryScores.get(group.groupId)?.recoveryValue ?? 0),
    0,
  );
  const selectedRecoveryValue = selected.reduce(
    (total, ranked) => total + (primaryScores.get(ranked.group.groupId)?.recoveryValue ?? 0),
    0,
  );
  const dependencyWeighted = (group: SessionRetentionGroup): number => {
    const score = primaryScores.get(group.groupId)?.recoveryValue ?? 0;
    return score * (1 + Math.log1p(group.descendantCount + group.forkFanout));
  };
  const totalDependencyWeightedValue = availableGroups.reduce(
    (total, group) => total + dependencyWeighted(group),
    0,
  );
  const selectedDependencyWeightedValue = selected.reduce(
    (total, ranked) => total + dependencyWeighted(ranked.group),
    0,
  );
  const highValueCount = Math.max(1, Math.ceil(availableGroups.length * 0.1));
  const highValueGroups = availableGroups
    .toSorted(
      (left, right) =>
        (primaryScores.get(right.groupId)?.recoveryValue ?? 0) -
          (primaryScores.get(left.groupId)?.recoveryValue ?? 0) ||
        left.groupId.localeCompare(right.groupId),
    )
    .slice(0, highValueCount);
  const protectedGroupViolations = selected.filter(
    (ranked) =>
      ranked.group.protected || params.protectedGroupIds?.has(ranked.group.groupId) === true,
  ).length;
  return {
    policy: params.policy,
    targetBytes: Math.max(0, params.targetBytes),
    actualBytesSelected: selected.reduce(
      (total, ranked) => total + ranked.group.reclaimableBytes,
      0,
    ),
    ownershipGroupsSelected: selected.length,
    sessionsSelected: selected.reduce((total, ranked) => total + ranked.group.sessionIds.length, 0),
    estimatedRecoveryValuePreserved: roundMetric(totalRecoveryValue - selectedRecoveryValue),
    dependencyWeightedValuePreserved: roundMetric(
      totalDependencyWeightedValue - selectedDependencyWeightedValue,
    ),
    highValueGroupsPreserved: highValueGroups.filter(
      (group) => !selectedGroupIds.has(group.groupId),
    ).length,
    recoveryValueByCost: recoveryCurve(params.groups),
    protectedGroupViolations,
    ownershipGroupSplits: 0,
    selectedGroupIds: [...selectedGroupIds],
  };
}
