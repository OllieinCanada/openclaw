export type ReleasePurpose =
  | "beta-publish"
  | "stable-publish"
  | "postpublish-confidence"
  | "main-qualification";

export type ReleasePlan = {
  schema: "openclaw.release-plan.v1";
  releaseId: string;
  version: string;
  tag: string | null;
  candidateSha: string;
  tooling: {
    repository: string;
    workflowPath: string;
    ref: string;
    fullRef: string;
    sha: string;
  };
  purpose: ReleasePurpose;
  packages: Array<{ kind: string; name: string }>;
  platforms: string[];
  validation: {
    profile: "beta" | "stable" | "full";
    requiredGroups: string[];
    exceptions: Array<{ code: string; reason: string }>;
  };
};

export type ReleasePlanLock = {
  schema: "openclaw.release-plan-lock.v1";
  digest: string;
  plan: ReleasePlan;
};

export type ValidationAttemptRequest = {
  schema: "openclaw.validation-attempt-request.v1";
  planDigest: string;
  rerunGroup: string;
  filters: Record<string, string>;
  failFast: boolean;
  reuseEvidence: boolean;
};

export type ValidationAttemptReceipt = {
  schema: "openclaw.validation-attempt-receipt.v1";
  planDigest: string;
  requestDigest: string;
  runId: string;
  runAttempt: string;
  workflowRef: string;
  workflowFullRef: string;
  workflowSha: string;
  targetSha: string;
};

export const RELEASE_PLAN_SCHEMA: "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA: "openclaw.release-plan-lock.v1";
export const VALIDATION_ATTEMPT_REQUEST_SCHEMA: "openclaw.validation-attempt-request.v1";
export const VALIDATION_ATTEMPT_RECEIPT_SCHEMA: "openclaw.validation-attempt-receipt.v1";
export const RELEASE_PLAN_MAX_BYTES: number;
export const VALIDATION_ATTEMPT_REQUEST_MAX_BYTES: number;
export function canonicalJson(value: unknown): string;
export function sha256Digest(value: unknown): string;
export function validateReleasePlan(value: unknown): ReleasePlan;
export function createReleasePlanLock(value: unknown): ReleasePlanLock;
export function validateReleasePlanLock(value: unknown): ReleasePlanLock;
export function readReleasePlanLock(path: string): ReleasePlanLock;
export function validateValidationAttemptRequest(value: unknown): ValidationAttemptRequest;
export function validateValidationAttemptReceipt(value: unknown): ValidationAttemptReceipt;
export function assertPublishableReleasePlan(
  plan: unknown,
  releaseTag: string,
  candidateSha: string,
): ReleasePlan;
