#!/usr/bin/env node
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import {
  canonicalJson,
  createReleasePlanLock,
  readReleasePlanLock,
  VALIDATION_ATTEMPT_REQUEST_SCHEMA,
  validateValidationAttemptRequest,
} from "./release-plan-contract.mjs";

function usage() {
  console.error(
    "Usage: node scripts/release-plan-lock.mjs create --input <plan.json> [--output <lock.json>]\n" +
      "       node scripts/release-plan-lock.mjs envelope --lock <lock.json> --rerun-group <group> [--fail-fast true|false] [--reuse-evidence true|false] [--filter key=value]",
  );
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== "create" && command !== "envelope") {
    throw new Error("release plan lock command must be create or envelope");
  }
  const options = {
    command,
    input: "",
    output: "",
    lock: "",
    rerunGroup: "",
    failFast: "false",
    reuseEvidence: "true",
    filters: [],
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--input" ||
      arg === "--output" ||
      arg === "--lock" ||
      arg === "--rerun-group" ||
      arg === "--fail-fast" ||
      arg === "--reuse-evidence"
    ) {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
      if (seen.has(arg)) {
        throw new Error(`${arg} may be specified only once`);
      }
      seen.add(arg);
      options[key] = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--filter") {
      options.filters.push(readOption(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (command === "create" && !options.input) {
    throw new Error("--input is required");
  }
  if (command === "envelope" && (!options.lock || !options.rerunGroup)) {
    throw new Error("envelope requires --lock and --rerun-group");
  }
  if (!["true", "false"].includes(options.failFast)) {
    throw new Error("--fail-fast must be true or false");
  }
  if (!["true", "false"].includes(options.reuseEvidence)) {
    throw new Error("--reuse-evidence must be true or false");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "envelope") {
    const releasePlanLock = readReleasePlanLock(options.lock);
    const filters = Object.fromEntries(
      options.filters.map((assignment) => {
        const separator = assignment.indexOf("=");
        if (separator < 1) {
          throw new Error("--filter must use key=value");
        }
        return [assignment.slice(0, separator), assignment.slice(separator + 1)];
      }),
    );
    const validationAttemptRequest = validateValidationAttemptRequest({
      schema: VALIDATION_ATTEMPT_REQUEST_SCHEMA,
      planDigest: releasePlanLock.digest,
      rerunGroup: options.rerunGroup,
      filters,
      failFast: options.failFast === "true",
      reuseEvidence: options.reuseEvidence === "true",
    });
    process.stdout.write(`${canonicalJson({ releasePlanLock, validationAttemptRequest })}\n`);
    return;
  }
  const plan = JSON.parse(readFileSync(options.input, "utf8"));
  const output = `${JSON.stringify(createReleasePlanLock(plan), null, 2)}\n`;
  if (!options.output) {
    process.stdout.write(output);
    return;
  }
  const descriptor = openSync(options.output, "wx", 0o600);
  try {
    writeFileSync(descriptor, output, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

try {
  main();
} catch (error) {
  usage();
  console.error(
    `[release-plan-lock] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("[release-plan-lock] FAILED (exit 1)");
  process.exitCode = 1;
}
