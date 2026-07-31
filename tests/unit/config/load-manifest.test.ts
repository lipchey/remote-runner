import { describe, expect, it } from "vitest";

import { loadManifestText } from "../../../src/config/load-manifest.js";
import { validManifest } from "./manifest-fixture.js";

describe("loadManifestText", () => {
  it("accepts the v1 example and normalizes declared repository paths", () => {
    const manifest = loadManifestText(validManifest.replace(
      'setup: ["./scripts/ds-bootstrap.sh"]',
      'setup: ["scripts/./ds-bootstrap.sh"]',
    ));

    expect(manifest.profiles[0]?.id).toBe("verify-full");
    expect(manifest.profiles[0]?.bootstrap.setup).toEqual([
      "scripts/ds-bootstrap.sh",
    ]);
  });

  it("accepts an optional remote-tracking base ref for history-sensitive gates", () => {
    const manifest = loadManifestText(validManifest.replace(
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces", baseRef: origin/main }',
    ));

    expect(manifest.profiles[0]?.workspace.baseRef).toBe("origin/main");
  });

  it("accepts a built-in repository dotenv secret source instead of an external provider", () => {
    const manifest = loadManifestText(validManifest.replace(
      'provider: ["node", "scripts/remote-runner-env.mjs"]',
      "dotenv: .env",
    ));

    expect(manifest.profiles[0]?.secrets).toEqual({
      allow: ["NEON_DEV_DATABASE_URL"],
      dotenv: ".env",
    });
  });

  it("requires exactly one secret source", () => {
    expect(() => loadManifestText(validManifest.replace(
      'provider: ["node", "scripts/remote-runner-env.mjs"]',
      'provider: ["node", "scripts/remote-runner-env.mjs"], dotenv: .env',
    ))).toThrow(/exactly one/u);
    expect(() => loadManifestText(validManifest.replace(
      ', provider: ["node", "scripts/remote-runner-env.mjs"]',
      "",
    ))).toThrow(/exactly one/u);
  });

  it.each([
    ["manifest", "schemaVersion: 1", "schemaVersion: 1\nextra: true"],
    ["profile", "mode: auto", "mode: auto\n    extra: true"],
    ["remote", "hostKeySha256: \"SHA256:trusted\"", "hostKeySha256: \"SHA256:trusted\", extra: true"],
    ["workspace", 'generatedRoot: "~/.cache/remote-runner/workspaces"', 'generatedRoot: "~/.cache/remote-runner/workspaces", extra: true'],
    ["probes", "minimumFreeBytes: 10737418240", "minimumFreeBytes: 10737418240, extra: true"],
    ["sync", "ignores: [node_modules, .git]", "ignores: [node_modules, .git], extra: true"],
    ["bootstrap", "fingerprint: [package.json, pnpm-lock.yaml]", "fingerprint: [package.json, pnpm-lock.yaml], extra: true"],
    ["workload", 'childEnvironment: { REMOTE_RUNNER_CHILD: "1" }', 'childEnvironment: { REMOTE_RUNNER_CHILD: "1" }, extra: true'],
    ["secrets", 'provider: ["node", "scripts/remote-runner-env.mjs"]', 'provider: ["node", "scripts/remote-runner-env.mjs"], extra: true'],
    ["notifications", "policy: outage-recovery", "policy: outage-recovery, extra: true"],
    ["benchmark", 'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }]', 'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }], extra: true'],
    ["benchmark workload", 'id: full, command: ["./scripts/verify", "--full"]', 'id: full, command: ["./scripts/verify", "--full"], extra: true'],
  ])("rejects unknown %s fields", (_level, before, after) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(
      /unknown .* field: extra/,
    );
  });

  it("rejects duplicate YAML keys", () => {
    expect(() =>
      loadManifestText(validManifest.replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1")),
    ).toThrow(/duplicate|unique/i);
  });

  it("rejects duplicate profile and benchmark workload IDs", () => {
    const profile = validManifest.slice(validManifest.indexOf("  - id:"));
    expect(() => loadManifestText(`${validManifest}${profile}`)).toThrow(
      "duplicate profile id: verify-full",
    );
    expect(() =>
      loadManifestText(validManifest.replace(
        'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }]',
        'workloads: [{ id: full, command: ["./scripts/verify"] }, { id: full, command: ["./scripts/verify"] }] ',
      )),
    ).toThrow("duplicate benchmark workload id: full");
  });

  it.each([
    ["schema version", "schemaVersion: 1", "schemaVersion: 2", /schemaVersion.*1/],
    ["profile id", "id: verify-full", "id: Verify_full", /profile id/],
    ["mode", "mode: auto", "mode: sometimes", /profile mode/],
    ["fallback", "fallback: local", "fallback: remote", /profile fallback/],
    ["trusted fingerprint", 'hostKeySha256: "SHA256:trusted"', 'hostKeySha256: "MD5:bad"', /SHA256/],
    ["generated root", "~/.cache/remote-runner/workspaces", "/tmp", /generated root/],
    ["workspace base ref", 'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }', 'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces", baseRef: ../main }', /base ref/],
    ["probe attempts", "attempts: 2", "attempts: 3", /attempts.*2/],
    ["probe timeout lower bound", "connectTimeoutSeconds: 4", "connectTimeoutSeconds: 0", /connectTimeoutSeconds/],
    ["probe timeout upper bound", "connectTimeoutSeconds: 4", "connectTimeoutSeconds: 301", /connectTimeoutSeconds/],
    ["free byte bound", "minimumFreeBytes: 10737418240", "minimumFreeBytes: -1", /minimumFreeBytes/],
    ["sync provider", "provider: mutagen", "provider: rsync", /sync provider/],
    ["sync mode", "mode: one-way-replica", "mode: two-way-safe", /sync mode/],
    ["node bootstrap", "node: local-exact", "node: latest", /bootstrap node/],
    ["child environment name", "REMOTE_RUNNER_CHILD", "remote_runner_child", /environment name/],
    ["secret name", "NEON_DEV_DATABASE_URL", "NeonUrl", /secret name/],
    ["notification policy", "policy: outage-recovery", "policy: always", /notification policy/],
    ["benchmark sample lower bound", "samples: 3", "samples: 0", /benchmark samples/],
    ["benchmark sample upper bound", "samples: 3", "samples: 1001", /benchmark samples/],
  ])("rejects an invalid %s", (_case, before, after, message) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(message);
  });

  it("rejects missing or incorrectly typed required values", () => {
    expect(() => loadManifestText(validManifest.replace("    consumer: ariadne\n", ""))).toThrow(
      /profile consumer/,
    );
    expect(() => loadManifestText(validManifest.replace("consumer: ariadne", "consumer: 42"))).toThrow(
      /profile consumer/,
    );
  });

  it("rejects shell-string and empty commands", () => {
    expect(() =>
      loadManifestText(validManifest.replace('["./scripts/verify", "--full"]', '"./scripts/verify --full"')),
    ).toThrow(/argument array/);
    expect(() => loadManifestText(validManifest.replace('["node", "scripts/remote-runner-env.mjs"]', "[]"))).toThrow(
      /argument array/,
    );
    expect(() => loadManifestText(validManifest.replace('command: ["./scripts/verify", "--full"]', "command: []"))).toThrow(
      /argument array/,
    );
  });

  it.each([
    ["workload executable", "./scripts/verify", "./scripts/ver\\0ify"],
    ["workload argument", "--full", "--fu\\0ll"],
    ["provider executable", '"node", "scripts/remote-runner-env.mjs"', '"no\\0de", "scripts/remote-runner-env.mjs"'],
    ["provider argument", "scripts/remote-runner-env.mjs", "scripts/remote-runner-env\\0.mjs"],
    ["child environment value", 'REMOTE_RUNNER_CHILD: "1"', 'REMOTE_RUNNER_CHILD: "1\\0bad"'],
  ])("rejects NUL in a %s", (_case, before, after) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(
      /NUL/,
    );
  });

  it("accepts empty non-executable arguments and environment values", () => {
    const manifest = loadManifestText(
      validManifest
        .replace('command: ["./scripts/verify", "--full"]', 'command: ["./scripts/verify", ""]')
        .replace('provider: ["node", "scripts/remote-runner-env.mjs"]', 'provider: ["node", ""]')
        .replace('REMOTE_RUNNER_CHILD: "1"', 'REMOTE_RUNNER_CHILD: ""'),
    );

    expect(manifest.profiles[0]?.workload.command).toEqual([
      "./scripts/verify",
      "",
    ]);
    expect(manifest.profiles[0]?.secrets.provider).toEqual(["node", ""]);
    expect(manifest.profiles[0]?.workload.childEnvironment).toEqual({
      REMOTE_RUNNER_CHILD: "",
    });
  });

  it.each([
    ["package manager", "packageManager: package.json", "packageManager: ../package.json"],
    ["setup", 'setup: ["./scripts/ds-bootstrap.sh"]', 'setup: ["/tmp/setup.sh"]'],
    ["fingerprint", "fingerprint: [package.json, pnpm-lock.yaml]", "fingerprint: [package.json, ../../secret]"],
    ["dotenv", 'provider: ["node", "scripts/remote-runner-env.mjs"]', "dotenv: ../.env"],
  ])("rejects unsafe %s paths", (_case, before, after) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(
      /unsafe repository path/,
    );
  });
});
