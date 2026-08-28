import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RETENTION_TEMP_PREFIX = "openclaw-session-retention-";

function canonicalPath(targetPath: string): string {
  return fs.realpathSync(targetPath);
}

export function assertDisposableOpenClawStateDir(stateDir: string): string {
  const canonicalStateDir = canonicalPath(stateDir);
  const canonicalTempDir = canonicalPath(os.tmpdir());
  const relative = path.relative(canonicalTempDir, canonicalStateDir);
  const rootName = relative.split(path.sep)[0] ?? "";
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !rootName.startsWith(RETENTION_TEMP_PREFIX)
  ) {
    throw new Error(
      "Session retention analysis requires an isolated mkdtemp state directory under os.tmpdir()",
    );
  }
  return canonicalStateDir;
}

export function assertIsolatedStateEnvironment(stateDir: string): void {
  const canonicalStateDir = assertDisposableOpenClawStateDir(stateDir);
  const configuredStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!configuredStateDir || canonicalPath(configuredStateDir) !== canonicalStateDir) {
    throw new Error("OPENCLAW_STATE_DIR must point at the disposable analysis state directory");
  }
}
