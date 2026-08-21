import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRecord } from "./lib/record-shared.mjs";

export const RELEASE_PLAN_SCHEMA = "openclaw.release-plan.v1";
export const RELEASE_PLAN_LOCK_SCHEMA = "openclaw.release-plan-lock.v1";
export const VALIDATION_ATTEMPT_REQUEST_SCHEMA = "openclaw.validation-attempt-request.v1";
export const VALIDATION_ATTEMPT_RECEIPT_SCHEMA = "openclaw.validation-attempt-receipt.v1";
export const RELEASE_PLAN_MAX_BYTES = 32 * 1024;
export const VALIDATION_ATTEMPT_REQUEST_MAX_BYTES = 8 * 1024;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_PURPOSES = new Set([
  "beta-publish",
  "stable-publish",
  "postpublish-confidence",
  "main-qualification",
]);
const RELEASE_PROFILES = new Set(["beta", "stable", "full"]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).toSorted(compareStrings);
  const wanted = expected.toSorted(compareStrings);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}.`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredSha(value, label) {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`${label} must be a lowercase 40-character commit SHA.`);
  }
  return sha;
}

function requiredDigest(value, label) {
  const digest = requiredString(value, label);
  if (!DIGEST_PATTERN.test(digest)) {
    fail(`${label} must be a sha256 digest.`);
  }
  return digest;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array.`);
  }
  const normalized = value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} must not contain duplicates.`);
  }
  if (normalized.some((entry, index) => index > 0 && normalized[index - 1] >= entry)) {
    fail(`${label} must be sorted in ascending byte order.`);
  }
  return normalized;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted(compareStrings)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function validateTooling(value) {
  if (!isRecord(value)) {
    fail("release plan tooling must be an object.");
  }
  assertExactKeys(
    value,
    ["repository", "workflowPath", "ref", "fullRef", "sha"],
    "release plan tooling",
  );
  const repository = requiredString(value.repository, "release plan tooling repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("release plan tooling repository must be owner/name.");
  }
  const workflowPath = requiredString(value.workflowPath, "release plan tooling workflowPath");
  if (!workflowPath.startsWith(".github/workflows/")) {
    fail("release plan tooling workflowPath must name a workflow file.");
  }
  const ref = requiredString(value.ref, "release plan tooling ref");
  const fullRef = requiredString(value.fullRef, "release plan tooling fullRef");
  if (fullRef !== `refs/heads/${ref}` && fullRef !== `refs/tags/${ref}`) {
    fail("release plan tooling fullRef must exactly qualify ref.");
  }
  return {
    repository,
    workflowPath,
    ref,
    fullRef,
    sha: requiredSha(value.sha, "release plan tooling SHA"),
  };
}

function validatePackages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("release plan packages must be a non-empty array.");
  }
  const packages = value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`release plan packages[${index}] must be an object.`);
    }
    assertExactKeys(entry, ["kind", "name"], `release plan packages[${index}]`);
    return {
      kind: requiredString(entry.kind, `release plan packages[${index}].kind`),
      name: requiredString(entry.name, `release plan packages[${index}].name`),
    };
  });
  const identities = packages.map((entry) => `${entry.kind}:${entry.name}`);
  if (new Set(identities).size !== identities.length) {
    fail("release plan packages must not contain duplicates.");
  }
  if (identities.some((entry, index) => index > 0 && identities[index - 1] >= entry)) {
    fail("release plan packages must be sorted by kind and name.");
  }
  return packages;
}

function validateExceptions(value) {
  if (!Array.isArray(value)) {
    fail("release plan validation exceptions must be an array.");
  }
  const exceptions = value.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`release plan validation exceptions[${index}] must be an object.`);
    }
    assertExactKeys(entry, ["code", "reason"], `release plan validation exceptions[${index}]`);
    return {
      code: requiredString(entry.code, `release plan validation exceptions[${index}].code`),
      reason: requiredString(entry.reason, `release plan validation exceptions[${index}].reason`),
    };
  });
  const codes = exceptions.map((entry) => entry.code);
  if (new Set(codes).size !== codes.length) {
    fail("release plan validation exceptions must not contain duplicate codes.");
  }
  if (codes.some((entry, index) => index > 0 && codes[index - 1] >= entry)) {
    fail("release plan validation exceptions must be sorted by code.");
  }
  return exceptions;
}

export function validateReleasePlan(value) {
  if (!isRecord(value)) {
    fail("release plan must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schema",
      "releaseId",
      "version",
      "tag",
      "candidateSha",
      "tooling",
      "purpose",
      "packages",
      "platforms",
      "validation",
    ],
    "release plan",
  );
  if (value.schema !== RELEASE_PLAN_SCHEMA) {
    fail(`release plan schema must be ${RELEASE_PLAN_SCHEMA}.`);
  }
  const purpose = requiredString(value.purpose, "release plan purpose");
  if (!RELEASE_PURPOSES.has(purpose)) {
    fail(`release plan purpose is unsupported: ${purpose}.`);
  }
  if (value.tag !== null && (typeof value.tag !== "string" || value.tag.length === 0)) {
    fail("release plan tag must be a non-empty string or null.");
  }
  if (
    (purpose === "beta-publish" || purpose === "stable-publish") &&
    typeof value.tag !== "string"
  ) {
    fail(`${purpose} release plans require a tag.`);
  }
  if (
    (purpose === "beta-publish" || purpose === "stable-publish") &&
    value.tag !== `v${value.version}`
  ) {
    fail(`${purpose} release plan tag must match version.`);
  }
  if (!isRecord(value.validation)) {
    fail("release plan validation must be an object.");
  }
  assertExactKeys(
    value.validation,
    ["profile", "requiredGroups", "exceptions"],
    "release plan validation",
  );
  const profile = requiredString(value.validation.profile, "release plan validation profile");
  if (!RELEASE_PROFILES.has(profile)) {
    fail(`release plan validation profile is unsupported: ${profile}.`);
  }
  const plan = {
    schema: RELEASE_PLAN_SCHEMA,
    releaseId: requiredString(value.releaseId, "release plan releaseId"),
    version: requiredString(value.version, "release plan version"),
    tag: value.tag,
    candidateSha: requiredSha(value.candidateSha, "release plan candidateSha"),
    tooling: validateTooling(value.tooling),
    purpose,
    packages: validatePackages(value.packages),
    platforms: stringArray(value.platforms, "release plan platforms"),
    validation: {
      profile,
      requiredGroups: stringArray(
        value.validation.requiredGroups,
        "release plan validation requiredGroups",
      ),
      exceptions: validateExceptions(value.validation.exceptions),
    },
  };
  const bytes = Buffer.byteLength(canonicalJson(plan), "utf8");
  if (bytes > RELEASE_PLAN_MAX_BYTES) {
    fail(`release plan exceeds ${RELEASE_PLAN_MAX_BYTES} bytes.`);
  }
  return plan;
}

export function createReleasePlanLock(value) {
  const plan = validateReleasePlan(value);
  return {
    schema: RELEASE_PLAN_LOCK_SCHEMA,
    digest: sha256Digest(plan),
    plan,
  };
}

export function validateReleasePlanLock(value) {
  if (!isRecord(value)) {
    fail("release plan lock must be an object.");
  }
  assertExactKeys(value, ["schema", "digest", "plan"], "release plan lock");
  if (value.schema !== RELEASE_PLAN_LOCK_SCHEMA) {
    fail(`release plan lock schema must be ${RELEASE_PLAN_LOCK_SCHEMA}.`);
  }
  const plan = validateReleasePlan(value.plan);
  const digest = requiredDigest(value.digest, "release plan lock digest");
  const expected = sha256Digest(plan);
  if (digest !== expected) {
    fail(`release plan lock digest mismatch: expected ${expected}.`);
  }
  return { schema: RELEASE_PLAN_LOCK_SCHEMA, digest, plan };
}

export function readReleasePlanLock(path) {
  const raw = readFileSync(path);
  if (raw.byteLength > RELEASE_PLAN_MAX_BYTES + 4096) {
    fail("release plan lock file is too large.");
  }
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("release plan lock must contain valid JSON.", { cause: error });
  }
  return validateReleasePlanLock(value);
}

export function validateValidationAttemptRequest(value) {
  if (!isRecord(value)) {
    fail("validation attempt request must be an object.");
  }
  assertExactKeys(
    value,
    ["schema", "planDigest", "rerunGroup", "filters", "failFast", "reuseEvidence"],
    "validation attempt request",
  );
  if (value.schema !== VALIDATION_ATTEMPT_REQUEST_SCHEMA) {
    fail(`validation attempt request schema must be ${VALIDATION_ATTEMPT_REQUEST_SCHEMA}.`);
  }
  if (!isRecord(value.filters)) {
    fail("validation attempt request filters must be an object.");
  }
  const filters = Object.entries(value.filters).map(([key, entry]) => {
    requiredString(key, "validation attempt request filter key");
    if (typeof entry !== "string") {
      fail(`validation attempt request filter ${key} must be a string.`);
    }
    return [key, entry];
  });
  if (typeof value.failFast !== "boolean" || typeof value.reuseEvidence !== "boolean") {
    fail("validation attempt request failFast and reuseEvidence must be booleans.");
  }
  const request = {
    schema: VALIDATION_ATTEMPT_REQUEST_SCHEMA,
    planDigest: requiredDigest(value.planDigest, "validation attempt request planDigest"),
    rerunGroup: requiredString(value.rerunGroup, "validation attempt request rerunGroup"),
    filters: canonicalize(Object.fromEntries(filters.filter(([, entry]) => entry.length > 0))),
    failFast: value.failFast,
    reuseEvidence: value.reuseEvidence,
  };
  if (Buffer.byteLength(canonicalJson(request), "utf8") > VALIDATION_ATTEMPT_REQUEST_MAX_BYTES) {
    fail(`validation attempt request exceeds ${VALIDATION_ATTEMPT_REQUEST_MAX_BYTES} bytes.`);
  }
  return request;
}

export function validateValidationAttemptReceipt(value) {
  if (!isRecord(value)) {
    fail("validation attempt receipt must be an object.");
  }
  assertExactKeys(
    value,
    [
      "schema",
      "planDigest",
      "requestDigest",
      "runId",
      "runAttempt",
      "workflowRef",
      "workflowFullRef",
      "workflowSha",
      "targetSha",
    ],
    "validation attempt receipt",
  );
  if (value.schema !== VALIDATION_ATTEMPT_RECEIPT_SCHEMA) {
    fail(`validation attempt receipt schema must be ${VALIDATION_ATTEMPT_RECEIPT_SCHEMA}.`);
  }
  const runId = requiredString(value.runId, "validation attempt receipt runId");
  const runAttempt = requiredString(value.runAttempt, "validation attempt receipt runAttempt");
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    fail("validation attempt receipt runId and runAttempt must be positive integers.");
  }
  return {
    schema: VALIDATION_ATTEMPT_RECEIPT_SCHEMA,
    planDigest: requiredDigest(value.planDigest, "validation attempt receipt planDigest"),
    requestDigest: requiredDigest(value.requestDigest, "validation attempt receipt requestDigest"),
    runId,
    runAttempt,
    workflowRef: requiredString(value.workflowRef, "validation attempt receipt workflowRef"),
    workflowFullRef: requiredString(
      value.workflowFullRef,
      "validation attempt receipt workflowFullRef",
    ),
    workflowSha: requiredSha(value.workflowSha, "validation attempt receipt workflowSha"),
    targetSha: requiredSha(value.targetSha, "validation attempt receipt targetSha"),
  };
}

export function assertPublishableReleasePlan(plan, releaseTag, candidateSha) {
  const validated = validateReleasePlan(plan);
  if (validated.purpose === "main-qualification") {
    fail("main-qualification evidence cannot authorize publication.");
  }
  if (validated.purpose !== "beta-publish" && validated.purpose !== "stable-publish") {
    fail(`${validated.purpose} evidence cannot authorize publication.`);
  }
  if (validated.tag !== releaseTag) {
    fail(`release plan tag mismatch: expected ${releaseTag}, got ${validated.tag ?? "<none>"}.`);
  }
  if (validated.candidateSha !== candidateSha) {
    fail("release plan candidate SHA does not match the publication target.");
  }
  return validated;
}
