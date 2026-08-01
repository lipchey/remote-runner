import { posix } from "node:path";

import { parseDocument } from "yaml";

import { assertSafeRepositoryPath } from "../runtime/paths.js";
import type { ManifestV1, Profile } from "./types.js";

const PROFILE_ID = /^[a-z][a-z0-9-]*$/;
const UPPERCASE_NAME = /^[A-Z][A-Z0-9_]*$/;
const GENERATED_ROOT = "~/.cache/remote-runner/workspaces";
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function closed(value: unknown, fields: readonly string[], label: string): UnknownRecord {
  const result = record(value, label);
  const allowed = new Set(fields);
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) {
      throw new Error(`unknown ${label} field: ${field}`);
    }
  }
  return result;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function boundedInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function generatedRoot(value: unknown): string {
  const root = nonEmptyString(value, "generated root");
  if (root === GENERATED_ROOT) return root;
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    root === "/" ||
    /[\u0000-\u001f\u007f]/u.test(root)
  ) {
    throw new Error(`generated root must be ${GENERATED_ROOT} or a canonical non-root absolute path`);
  }
  return root;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function commandArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty argument array`);
  }
  const executable = value[0];
  if (typeof executable !== "string" || executable.trim().length === 0) {
    throw new Error(`${label} must have a non-empty executable`);
  }
  if (executable.includes("\0")) {
    throw new Error(`${label} executable must not contain NUL`);
  }
  for (const argument of value.slice(1)) {
    if (typeof argument !== "string") {
      throw new Error(`${label} must be an argument array`);
    }
    if (argument.includes("\0")) {
      throw new Error(`${label} argument must not contain NUL`);
    }
  }
  return [...value] as string[];
}

function safePaths(value: unknown, label: string): string[] {
  return stringArray(value, label).map(assertSafeRepositoryPath);
}

function artifactPaths(value: unknown): string[] {
  return stringArray(value, "bootstrap artifacts").map((path) => {
    const normalized = assertSafeRepositoryPath(path);
    if (normalized !== path || path.startsWith("./")) {
      throw new Error("bootstrap artifact must be a canonical safe repository path");
    }
    return normalized;
  });
}

function fingerprintPatterns(value: unknown): string[] {
  return stringArray(value, "bootstrap fingerprint patterns").map((pattern) => {
    if (
      pattern.startsWith("/") ||
      pattern.includes("\\") ||
      pattern.includes(":") ||
      /[\u0000-\u001f\u007f]/u.test(pattern) ||
      pattern.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("bootstrap fingerprint pattern must be a safe relative glob");
    }
    return pattern;
  });
}

function bootstrapFingerprint(value: unknown): { files: string[]; patterns: string[] } {
  if (Array.isArray(value)) {
    return { files: safePaths(value, "bootstrap fingerprint"), patterns: [] };
  }
  const source = closed(value, ["files", "patterns"], "bootstrap fingerprint");
  return {
    files: safePaths(source.files, "bootstrap fingerprint files"),
    patterns: fingerprintPatterns(source.patterns),
  };
}

function commandArrays(value: unknown, label: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of argument arrays`);
  return value.map((entry) => commandArray(entry, label));
}

function environment(value: unknown): Record<string, string> {
  const source = record(value, "workload childEnvironment");
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (!UPPERCASE_NAME.test(name)) {
      throw new Error(`invalid child environment name: ${name}`);
    }
    if (typeof entry !== "string") {
      throw new Error(`child environment ${name} must be a string`);
    }
    if (entry.includes("\0")) {
      throw new Error(`child environment ${name} must not contain NUL`);
    }
    result[name] = entry;
  }
  return result;
}

function secretNames(value: unknown): string[] {
  const names = stringArray(value, "secrets allow");
  for (const name of names) {
    if (!UPPERCASE_NAME.test(name)) {
      throw new Error(`invalid secret name: ${name}`);
    }
  }
  return names;
}

function parseProfile(value: unknown): Profile {
  const source = closed(
    value,
    [
      "id",
      "consumer",
      "mode",
      "fallback",
      "remote",
      "workspace",
      "probes",
      "sync",
      "bootstrap",
      "workload",
      "secrets",
      "notifications",
      "benchmark",
    ],
    "profile",
  );
  const id = nonEmptyString(source.id, "profile id");
  if (!PROFILE_ID.test(id)) {
    throw new Error(`invalid profile id: ${id}`);
  }

  const remote = closed(source.remote, ["label", "target", "hostKeySha256"], "remote");
  const hostKeySha256 = nonEmptyString(remote.hostKeySha256, "remote hostKeySha256");
  if (!/^SHA256:\S+$/.test(hostKeySha256)) {
    throw new Error("remote hostKeySha256 must be a trusted SHA256: fingerprint");
  }

  const workspace = closed(source.workspace, ["generatedRoot", "baseRef", "retention"], "workspace");
  const retentionSource =
    workspace.retention === undefined
      ? undefined
      : closed(workspace.retention, ["keep", "graceMinutes"], "workspace retention");
  const retention =
    retentionSource === undefined
      ? undefined
      : {
          keep: boundedInteger(retentionSource.keep, 64, "workspace retention keep"),
          graceMinutes: boundedInteger(retentionSource.graceMinutes, 10_080, "workspace retention graceMinutes"),
        };
  const baseRef = workspace.baseRef === undefined ? undefined : nonEmptyString(workspace.baseRef, "workspace base ref");
  if (baseRef !== undefined && !BASE_REF.test(baseRef)) {
    throw new Error("workspace base ref must be a safe remote-tracking name");
  }

  const probes = closed(source.probes, ["attempts", "connectTimeoutSeconds", "minimumFreeBytes"], "probes");
  if (probes.attempts !== 2) {
    throw new Error("probe attempts must be exactly 2");
  }

  const sync = closed(source.sync, ["provider", "mode", "ignores"], "sync");
  const bootstrap = closed(
    source.bootstrap,
    ["node", "packageManager", "setup", "artifacts", "ensure", "fingerprint"],
    "bootstrap",
  );
  const workload = closed(source.workload, ["command", "childEnvironment"], "workload");
  const secrets = closed(source.secrets, ["allow", "provider", "dotenv"], "secrets");
  const hasProvider = secrets.provider !== undefined;
  const hasDotenv = secrets.dotenv !== undefined;
  if (hasProvider === hasDotenv) {
    throw new Error("secrets must declare exactly one of provider or dotenv");
  }
  const notifications = closed(source.notifications, ["policy"], "notifications");
  const benchmark = closed(source.benchmark, ["samples", "workloads"], "benchmark");
  if (!Array.isArray(benchmark.workloads) || benchmark.workloads.length === 0) {
    throw new Error("benchmark workloads must be a non-empty array");
  }
  const workloadIds = new Set<string>();
  const benchmarkWorkloads = benchmark.workloads.map((entry) => {
    const item = closed(entry, ["id", "command"], "benchmark workload");
    const workloadId = nonEmptyString(item.id, "benchmark workload id");
    if (!PROFILE_ID.test(workloadId)) {
      throw new Error(`invalid benchmark workload id: ${workloadId}`);
    }
    if (workloadIds.has(workloadId)) {
      throw new Error(`duplicate benchmark workload id: ${workloadId}`);
    }
    workloadIds.add(workloadId);
    return {
      id: workloadId,
      command: commandArray(item.command, "benchmark workload command"),
    };
  });

  return {
    id,
    consumer: nonEmptyString(source.consumer, "profile consumer"),
    mode: oneOf(source.mode, ["auto", "local", "remote"], "profile mode"),
    fallback: oneOf(source.fallback, ["local", "fail"], "profile fallback"),
    remote: {
      label: nonEmptyString(remote.label, "remote label"),
      target: nonEmptyString(remote.target, "remote target"),
      hostKeySha256,
    },
    workspace: {
      generatedRoot: generatedRoot(workspace.generatedRoot),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(retention === undefined ? {} : { retention }),
    },
    probes: {
      attempts: 2,
      connectTimeoutSeconds: boundedInteger(probes.connectTimeoutSeconds, 300, "probe connectTimeoutSeconds"),
      minimumFreeBytes: boundedInteger(probes.minimumFreeBytes, Number.MAX_SAFE_INTEGER, "probe minimumFreeBytes"),
    },
    sync: {
      provider: literal(sync.provider, "mutagen", "sync provider"),
      mode: literal(sync.mode, "one-way-replica", "sync mode"),
      ignores: safePaths(sync.ignores, "sync ignores"),
    },
    bootstrap: {
      node: literal(bootstrap.node, "local-exact", "bootstrap node"),
      packageManager: assertSafeRepositoryPath(nonEmptyString(bootstrap.packageManager, "bootstrap packageManager")),
      setup: safePaths(bootstrap.setup, "bootstrap setup"),
      artifacts: bootstrap.artifacts === undefined ? [] : artifactPaths(bootstrap.artifacts),
      ensure: bootstrap.ensure === undefined ? [] : commandArrays(bootstrap.ensure, "bootstrap ensure command"),
      fingerprint: bootstrapFingerprint(bootstrap.fingerprint),
    },
    workload: {
      command: commandArray(workload.command, "workload command"),
      childEnvironment: environment(workload.childEnvironment),
    },
    secrets: {
      allow: secretNames(secrets.allow),
      ...(hasProvider
        ? { provider: commandArray(secrets.provider, "secrets provider") }
        : {
            dotenv: assertSafeRepositoryPath(nonEmptyString(secrets.dotenv, "secrets dotenv")),
          }),
    },
    notifications: {
      policy: literal(notifications.policy, "outage-recovery", "notification policy"),
    },
    benchmark: {
      samples: boundedInteger(benchmark.samples, 1000, "benchmark samples"),
      workloads: benchmarkWorkloads,
    },
  };
}

export function loadManifestText(text: string): ManifestV1 {
  const document = parseDocument(text, { uniqueKeys: true });
  const parseError = document.errors[0];
  if (parseError !== undefined) {
    throw new Error(parseError.message);
  }

  const source = closed(document.toJS(), ["schemaVersion", "profiles"], "manifest");
  if (source.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (!Array.isArray(source.profiles) || source.profiles.length === 0) {
    throw new Error("profiles must be a non-empty array");
  }

  const profileIds = new Set<string>();
  const profiles = source.profiles.map((entry) => {
    const profile = parseProfile(entry);
    if (profileIds.has(profile.id)) {
      throw new Error(`duplicate profile id: ${profile.id}`);
    }
    profileIds.add(profile.id);
    return profile;
  });

  return { schemaVersion: 1, profiles };
}
