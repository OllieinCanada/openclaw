import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateReleasePlanLock } from "../../scripts/release-plan-contract.mjs";

const SCRIPT = "scripts/release-plan-lock.mjs";

function plan() {
  return {
    schema: "openclaw.release-plan.v1",
    releaseId: "2026.8.1-beta.3",
    version: "2026.8.1-beta.3",
    tag: "v2026.8.1-beta.3",
    candidateSha: "a".repeat(40),
    tooling: {
      repository: "openclaw/openclaw",
      workflowPath: ".github/workflows/full-release-validation.yml",
      ref: `release-publish/${"b".repeat(12)}-123`,
      fullRef: `refs/tags/release-publish/${"b".repeat(12)}-123`,
      sha: "b".repeat(40),
    },
    purpose: "beta-publish",
    packages: [{ kind: "npm", name: "openclaw" }],
    platforms: ["linux"],
    validation: {
      profile: "beta",
      requiredGroups: ["all"],
      exceptions: [],
    },
  };
}

describe("release-plan-lock", () => {
  it("creates one canonical lock and refuses to overwrite it", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-plan-"));
    const input = join(root, "plan.json");
    const output = join(root, "lock.json");
    try {
      writeFileSync(input, JSON.stringify(plan()));
      const first = spawnSync(
        process.execPath,
        [SCRIPT, "create", "--input", input, "--output", output],
        { encoding: "utf8" },
      );
      expect(first.status, first.stderr).toBe(0);
      expect(validateReleasePlanLock(JSON.parse(readFileSync(output, "utf8")))).toMatchObject({
        schema: "openclaw.release-plan-lock.v1",
      });
      const envelope = spawnSync(
        process.execPath,
        [SCRIPT, "envelope", "--lock", output, "--rerun-group", "all", "--filter", "liveSuite="],
        { encoding: "utf8" },
      );
      expect(envelope.status, envelope.stderr).toBe(0);
      expect(JSON.parse(envelope.stdout)).toMatchObject({
        releasePlanLock: { schema: "openclaw.release-plan-lock.v1" },
        validationAttemptRequest: {
          planDigest: validateReleasePlanLock(JSON.parse(readFileSync(output, "utf8"))).digest,
          rerunGroup: "all",
        },
      });

      const second = spawnSync(
        process.execPath,
        [SCRIPT, "create", "--input", input, "--output", output],
        { encoding: "utf8" },
      );
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("[release-plan-lock] FAILED (exit 1)");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
