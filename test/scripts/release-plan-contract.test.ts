import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertPublishableReleasePlan,
  canonicalJson,
  createReleasePlanLock,
  sha256Digest,
  validateReleasePlan,
  validateReleasePlanLock,
  validateValidationAttemptReceipt,
  validateValidationAttemptRequest,
} from "../../scripts/release-plan-contract.mjs";

const candidateSha = "a".repeat(40);
const toolingSha = "b".repeat(40);

function releasePlan(overrides: Record<string, unknown> = {}) {
  return {
    schema: "openclaw.release-plan.v1",
    releaseId: "2026.8.1-beta.3",
    version: "2026.8.1-beta.3",
    tag: "v2026.8.1-beta.3",
    candidateSha,
    tooling: {
      repository: "openclaw/openclaw",
      workflowPath: ".github/workflows/full-release-validation.yml",
      ref: `release-publish/${toolingSha.slice(0, 12)}-123`,
      fullRef: `refs/tags/release-publish/${toolingSha.slice(0, 12)}-123`,
      sha: toolingSha,
    },
    purpose: "beta-publish",
    packages: [
      { kind: "clawhub", name: "@openclaw/example" },
      { kind: "npm", name: "@openclaw/example" },
      { kind: "npm", name: "openclaw" },
    ],
    platforms: ["android", "docker", "ios", "linux", "macos", "windows"],
    validation: {
      profile: "beta",
      requiredGroups: ["ci", "performance", "plugin-prerelease", "release-checks"],
      exceptions: [],
    },
    ...overrides,
  };
}

describe("release plan contract", () => {
  it("canonicalizes and digests immutable release intent deterministically", () => {
    const plan = validateReleasePlan(releasePlan());
    const lock = createReleasePlanLock(plan);

    expect(lock).toEqual(validateReleasePlanLock(JSON.parse(JSON.stringify(lock))));
    expect(lock.digest).toBe(sha256Digest(plan));
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
  });

  it("keeps the public lock fixture byte-stable for the private controller", () => {
    const fixture = JSON.parse(readFileSync("test/fixtures/release-plan-lock.v1.json", "utf8"));

    expect(validateReleasePlanLock(fixture)).toEqual(fixture);
  });

  it("rejects unknown keys, unstable ordering, and excluded observations", () => {
    expect(() => validateReleasePlan({ ...releasePlan(), createdAt: "now" })).toThrow(
      "keys must be exactly",
    );
    expect(() =>
      validateReleasePlan({
        ...releasePlan(),
        validation: { ...releasePlan().validation, rerunGroup: "all" },
      }),
    ).toThrow("keys must be exactly");
    expect(() =>
      validateReleasePlan({
        ...releasePlan(),
        platforms: ["windows", "linux"],
      }),
    ).toThrow("sorted");
  });

  it("keeps attempt controls and observed run identity outside the release plan", () => {
    const planDigest = createReleasePlanLock(releasePlan()).digest;
    const request = validateValidationAttemptRequest({
      schema: "openclaw.validation-attempt-request.v1",
      planDigest,
      rerunGroup: "release-checks",
      filters: { liveSuite: "", crossOsSuite: "windows/packaged-upgrade" },
      failFast: false,
      reuseEvidence: true,
    });
    const requestDigest = sha256Digest(request);
    expect(request.filters).toEqual({ crossOsSuite: "windows/packaged-upgrade" });

    expect(
      validateValidationAttemptReceipt({
        schema: "openclaw.validation-attempt-receipt.v1",
        planDigest,
        requestDigest,
        runId: "123",
        runAttempt: "2",
        workflowRef: `release-ci/${toolingSha.slice(0, 12)}-123`,
        workflowFullRef: `refs/heads/release-ci/${toolingSha.slice(0, 12)}-123`,
        workflowSha: toolingSha,
        targetSha: candidateSha,
      }),
    ).toMatchObject({ planDigest, requestDigest, runId: "123" });
  });

  it("rejects qualification evidence at the publication boundary", () => {
    expect(() =>
      assertPublishableReleasePlan(
        { ...releasePlan(), purpose: "main-qualification", tag: null },
        "v2026.8.1-beta.3",
        candidateSha,
      ),
    ).toThrow("cannot authorize publication");
    expect(
      assertPublishableReleasePlan(releasePlan(), "v2026.8.1-beta.3", candidateSha),
    ).toMatchObject({ purpose: "beta-publish" });
  });
});
