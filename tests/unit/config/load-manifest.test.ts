import { describe, expect, it } from "vitest";

import { loadManifestText, remoteFallbackOf } from "../../../src/config/load-manifest.js";
import { validArtifactManifest, validManifest } from "./manifest-fixture.js";

const profileBlock = validManifest.slice(validManifest.indexOf("  - id:"));

function appendedProfile(...replacements: ReadonlyArray<readonly [string, string]>): string {
  return replacements.reduce((profile, [before, after]) => profile.replace(before, after), profileBlock);
}

describe("loadManifestText", () => {
  it("accepts the v1 example and normalizes declared repository paths", () => {
    const manifest = loadManifestText(
      validManifest.replace('setup: ["./scripts/ds-bootstrap.sh"]', 'setup: ["scripts/./ds-bootstrap.sh"]'),
    );

    expect(manifest.profiles[0]?.id).toBe("verify-full");
    expect(manifest.profiles[0]?.bootstrap.setup).toEqual(["scripts/ds-bootstrap.sh"]);
  });

  it("accepts a fallback naming another profile of the same consumer", () => {
    const manifest = loadManifestText(
      `${validManifest}${appendedProfile(
        ["id: verify-full", "id: verify-full-pop-os"],
        ["fallback: local", "fallback: verify-full"],
      )}`,
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os");

    expect(primary).toBeDefined();
    expect(remoteFallbackOf(manifest, primary!)).toMatchObject({ id: "verify-full" });
  });

  it("rejects a profile falling back to itself", () => {
    expect(() => loadManifestText(validManifest.replace("fallback: local", "fallback: verify-full"))).toThrow(
      /falls back to itself/u,
    );
  });

  it("rejects an unknown fallback profile", () => {
    expect(() => loadManifestText(validManifest.replace("fallback: local", "fallback: missing"))).toThrow(
      /unknown fallback profile/u,
    );
  });

  it("rejects a fallback target that names a remote fallback", () => {
    const middle = appendedProfile(["id: verify-full", "id: verify-mid"], ["fallback: local", "fallback: verify-full"]);
    const primary = appendedProfile(
      ["id: verify-full", "id: verify-primary"],
      ["fallback: local", "fallback: verify-mid"],
    );

    expect(() => loadManifestText(`${validManifest}${middle}${primary}`)).toThrow(/must not name a remote fallback/u);
  });

  it("rejects a fallback target of another consumer", () => {
    const primary = appendedProfile(
      ["id: verify-full", "id: verify-primary"],
      ["consumer: ariadne", "consumer: another"],
      ["fallback: local", "fallback: verify-full"],
    );

    expect(() => loadManifestText(`${validManifest}${primary}`)).toThrow(/belongs to another consumer/u);
  });

  it.each([
    ["a fallback label containing a space", validManifest.replace("label: pop-os", "label: pop os"), "verify-primary"],
    ["a 129-character primary id", validManifest, "p".repeat(129)],
  ])("rejects invalid v2 event fields for %s", (_description, fallbackManifest, primaryId) => {
    const primary = appendedProfile(
      ["id: verify-full", `id: ${primaryId}`],
      ["fallback: local", "fallback: verify-full"],
    );

    expect(() => loadManifestText(`${fallbackManifest}${primary}`)).toThrow(/invalid fallback event field/u);
  });

  it.each(["local", "fail"])("reserves the profile id %s", (id) => {
    expect(() => loadManifestText(validManifest.replace("id: verify-full", `id: ${id}`))).toThrow(
      /reserved profile id/u,
    );
  });

  it.each(["REMOTE_RUNNER_SELECTED_PROFILE", "REMOTE_RUNNER_REMOTE_LABEL"])(
    "rejects the runner's reserved marker %s as a childEnvironment key",
    (name) => {
      expect(() => loadManifestText(validManifest.replace("REMOTE_RUNNER_CHILD", name))).toThrow(
        /reserved child environment/u,
      );
    },
  );

  it.each(["REMOTE_RUNNER_SELECTED_PROFILE", "REMOTE_RUNNER_REMOTE_LABEL"])(
    "rejects the runner's reserved marker %s as a secret name",
    (name) => {
      expect(() => loadManifestText(validManifest.replace("NEON_DEV_DATABASE_URL", name))).toThrow(
        /reserved child environment/u,
      );
    },
  );

  it("keeps REMOTE_RUNNER_CHILD legal as a childEnvironment key", () => {
    expect(loadManifestText(validManifest).profiles[0]?.workload.childEnvironment).toEqual({
      REMOTE_RUNNER_CHILD: "1",
    });
  });

  it("rejects an unsafe consumer namespace", () => {
    expect(() => loadManifestText(validManifest.replace("consumer: ariadne", `consumer: ${"a".repeat(64)}`))).toThrow(
      /safe session component/u,
    );
  });

  it("accepts an optional remote-tracking base ref for history-sensitive gates", () => {
    const manifest = loadManifestText(
      validManifest.replace(
        'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
        'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces", baseRef: origin/main }',
      ),
    );

    expect(manifest.profiles[0]?.workspace.baseRef).toBe("origin/main");
  });

  it("accepts a canonical absolute generated root with bounded retention", () => {
    const manifest = loadManifestText(
      validManifest.replace(
        'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
        'workspace: { generatedRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces", retention: { keep: 3, graceMinutes: 60 } }',
      ),
    );

    expect(manifest.profiles[0]?.workspace).toEqual({
      generatedRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces",
      retention: { keep: 3, graceMinutes: 60 },
    });
  });

  it("keeps the legacy generated root backward compatible without enabling retention", () => {
    const manifest = loadManifestText(validManifest);

    expect(manifest.profiles[0]?.workspace).toEqual({
      generatedRoot: "~/.cache/remote-runner/workspaces",
    });
  });

  it("accepts ensure commands and object-form fingerprint discovery", () => {
    const manifest = loadManifestText(
      validManifest.replace(
        'setup: ["./scripts/ds-bootstrap.sh"], fingerprint: [package.json, pnpm-lock.yaml]',
        'setup: ["./scripts/ds-bootstrap.sh"], ensure: [["node", "scripts/pnpm-state.mjs"]], fingerprint: { files: [package.json, pnpm-lock.yaml], patterns: ["**/package.json", "**/uv.lock"] }',
      ),
    );

    expect(manifest.profiles[0]?.bootstrap).toMatchObject({
      ensure: [["node", "scripts/pnpm-state.mjs"]],
      fingerprint: {
        files: ["package.json", "pnpm-lock.yaml"],
        patterns: ["**/package.json", "**/uv.lock"],
      },
    });
  });

  it("accepts exact bootstrap artifact files", () => {
    const manifest = loadManifestText(validArtifactManifest);

    expect(manifest.profiles[0]?.bootstrap.artifacts).toEqual([
      "vendor/dev-standards/runner/dist/verify-runner.mjs",
      "vendor/dev-standards/runner/dist/.built-from",
    ]);
  });

  it("normalizes omitted bootstrap artifacts and ensure commands", () => {
    const manifest = loadManifestText(validManifest);

    expect(manifest.profiles[0]?.bootstrap.artifacts).toEqual([]);
    expect(manifest.profiles[0]?.bootstrap.ensure).toEqual([]);
    expect(manifest.profiles[0]?.bootstrap.fingerprint).toEqual({
      files: ["package.json", "pnpm-lock.yaml"],
      patterns: [],
    });
  });

  it("accepts a built-in repository dotenv secret source instead of an external provider", () => {
    const manifest = loadManifestText(
      validManifest.replace('provider: ["node", "scripts/remote-runner-env.mjs"]', "dotenv: .env"),
    );

    expect(manifest.profiles[0]?.secrets).toEqual({
      allow: ["NEON_DEV_DATABASE_URL"],
      dotenv: ".env",
    });
  });

  it("excludes the dotenv secret source from the sync even when the consumer forgot to", () => {
    const manifest = loadManifestText(
      validManifest.replace('provider: ["node", "scripts/remote-runner-env.mjs"]', "dotenv: config/local.env"),
    );

    expect(manifest.profiles[0]?.sync.ignores).toEqual(["node_modules", ".git", "config/local.env"]);
    expect(loadManifestText(validManifest).profiles[0]?.sync.ignores).toEqual(["node_modules", ".git"]);
  });

  it("rejects a remote target carrying git transport syntax", () => {
    for (const target of ['"ext::sh -c \\"touch /tmp/pwned\\""', '"-oProxyCommand=touch /tmp/pwned"', '"a b"']) {
      expect(() => loadManifestText(validManifest.replace("target: admin@pop-os", `target: ${target}`))).toThrow(
        /plain \[user@\]host/u,
      );
    }
    expect(loadManifestText(validManifest).profiles[0]?.remote.target).toBe("admin@pop-os");
  });

  it("requires exactly one secret source", () => {
    expect(() =>
      loadManifestText(
        validManifest.replace(
          'provider: ["node", "scripts/remote-runner-env.mjs"]',
          'provider: ["node", "scripts/remote-runner-env.mjs"], dotenv: .env',
        ),
      ),
    ).toThrow(/exactly one/u);
    expect(() =>
      loadManifestText(validManifest.replace(', provider: ["node", "scripts/remote-runner-env.mjs"]', "")),
    ).toThrow(/exactly one/u);
  });

  it.each([
    ["manifest", "schemaVersion: 1", "schemaVersion: 1\nextra: true"],
    ["profile", "mode: auto", "mode: auto\n    extra: true"],
    ["remote", 'hostKeySha256: "SHA256:trusted"', 'hostKeySha256: "SHA256:trusted", extra: true'],
    [
      "workspace",
      'generatedRoot: "~/.cache/remote-runner/workspaces"',
      'generatedRoot: "~/.cache/remote-runner/workspaces", extra: true',
    ],
    [
      "workspace retention",
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces", retention: { keep: 3, graceMinutes: 60, extra: true } }',
    ],
    ["probes", "minimumFreeBytes: 10737418240", "minimumFreeBytes: 10737418240, extra: true"],
    ["sync", "ignores: [node_modules, .git]", "ignores: [node_modules, .git], extra: true"],
    [
      "bootstrap",
      "fingerprint: [package.json, pnpm-lock.yaml]",
      "fingerprint: [package.json, pnpm-lock.yaml], extra: true",
    ],
    [
      "fingerprint",
      "fingerprint: [package.json, pnpm-lock.yaml]",
      "fingerprint: { files: [package.json], patterns: [], extra: true }",
    ],
    [
      "workload",
      'childEnvironment: { REMOTE_RUNNER_CHILD: "1" }',
      'childEnvironment: { REMOTE_RUNNER_CHILD: "1" }, extra: true',
    ],
    [
      "secrets",
      'provider: ["node", "scripts/remote-runner-env.mjs"]',
      'provider: ["node", "scripts/remote-runner-env.mjs"], extra: true',
    ],
    ["notifications", "policy: outage-recovery", "policy: outage-recovery, extra: true"],
    [
      "benchmark",
      'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }]',
      'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }], extra: true',
    ],
    [
      "benchmark workload",
      'id: full, command: ["./scripts/verify", "--full"]',
      'id: full, command: ["./scripts/verify", "--full"], extra: true',
    ],
  ])("rejects unknown %s fields", (_level, before, after) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(/unknown .* field: extra/);
  });

  it("rejects duplicate YAML keys", () => {
    expect(() =>
      loadManifestText(validManifest.replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1")),
    ).toThrow(/duplicate|unique/i);
  });

  it("rejects duplicate profile and benchmark workload IDs", () => {
    const profile = validManifest.slice(validManifest.indexOf("  - id:"));
    expect(() => loadManifestText(`${validManifest}${profile}`)).toThrow("duplicate profile id: verify-full");
    expect(() =>
      loadManifestText(
        validManifest.replace(
          'workloads: [{ id: full, command: ["./scripts/verify", "--full"] }]',
          'workloads: [{ id: full, command: ["./scripts/verify"] }, { id: full, command: ["./scripts/verify"] }] ',
        ),
      ),
    ).toThrow("duplicate benchmark workload id: full");
  });

  it.each([
    ["schema version", "schemaVersion: 1", "schemaVersion: 2", /schemaVersion.*1/],
    ["profile id", "id: verify-full", "id: Verify_full", /profile id/],
    ["mode", "mode: auto", "mode: sometimes", /profile mode/],
    ["fallback", "fallback: local", "fallback: invalid/name", /invalid profile fallback/],
    ["trusted fingerprint", 'hostKeySha256: "SHA256:trusted"', 'hostKeySha256: "MD5:bad"', /SHA256/],
    ["generated root", "~/.cache/remote-runner/workspaces", "relative/workspaces", /generated root/],
    [
      "workspace base ref",
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces", baseRef: ../main }',
      /base ref/,
    ],
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
    ["benchmark sample lower bound", "samples: 3", "samples: 2", /benchmark samples/],
    ["benchmark sample upper bound", "samples: 3", "samples: 1001", /benchmark samples/],
  ])("rejects an invalid %s", (_case, before, after, message) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(message);
  });

  it.each(["/", "/mnt/DataAI/../workspaces", "~/other", "relative/workspaces"])(
    "rejects unsafe generated root %s",
    (generatedRoot) => {
      expect(() =>
        loadManifestText(
          validManifest.replace(
            'generatedRoot: "~/.cache/remote-runner/workspaces"',
            `generatedRoot: "${generatedRoot}"`,
          ),
        ),
      ).toThrow(/generated root/u);
    },
  );

  it.each([
    ["keep lower", "keep: 3", "keep: 0"],
    ["keep upper", "keep: 3", "keep: 65"],
    ["grace lower", "graceMinutes: 60", "graceMinutes: 0"],
    ["grace upper", "graceMinutes: 60", "graceMinutes: 10081"],
  ])("rejects invalid retention %s", (_case, before, after) => {
    const withRetention = validManifest.replace(
      'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
      'workspace: { generatedRoot: "/mnt/DataAI/workspaces", retention: { keep: 3, graceMinutes: 60 } }',
    );
    expect(() => loadManifestText(withRetention.replace(before, after))).toThrow(/retention/u);
  });

  it("rejects missing or incorrectly typed required values", () => {
    expect(() => loadManifestText(validManifest.replace("    consumer: ariadne\n", ""))).toThrow(/profile consumer/);
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
    expect(() =>
      loadManifestText(validManifest.replace('command: ["./scripts/verify", "--full"]', "command: []")),
    ).toThrow(/argument array/);
    expect(() =>
      loadManifestText(
        validManifest.replace(
          'setup: ["./scripts/ds-bootstrap.sh"], fingerprint:',
          'setup: ["./scripts/ds-bootstrap.sh"], ensure: [[]], fingerprint:',
        ),
      ),
    ).toThrow(/argument array/);
  });

  it.each([
    ["workload executable", "./scripts/verify", "./scripts/ver\\0ify"],
    ["workload argument", "--full", "--fu\\0ll"],
    ["provider executable", '"node", "scripts/remote-runner-env.mjs"', '"no\\0de", "scripts/remote-runner-env.mjs"'],
    ["provider argument", "scripts/remote-runner-env.mjs", "scripts/remote-runner-env\\0.mjs"],
    ["child environment value", 'REMOTE_RUNNER_CHILD: "1"', 'REMOTE_RUNNER_CHILD: "1\\0bad"'],
    [
      "ensure executable",
      'setup: ["./scripts/ds-bootstrap.sh"], fingerprint:',
      'setup: ["./scripts/ds-bootstrap.sh"], ensure: [["no\\0de"]], fingerprint:',
    ],
    [
      "ensure argument",
      'setup: ["./scripts/ds-bootstrap.sh"], fingerprint:',
      'setup: ["./scripts/ds-bootstrap.sh"], ensure: [["node", "bad\\0arg"]], fingerprint:',
    ],
  ])("rejects NUL in a %s", (_case, before, after) => {
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(/NUL/);
  });

  it("accepts empty non-executable arguments and environment values", () => {
    const manifest = loadManifestText(
      validManifest
        .replace('command: ["./scripts/verify", "--full"]', 'command: ["./scripts/verify", ""]')
        .replace('provider: ["node", "scripts/remote-runner-env.mjs"]', 'provider: ["node", ""]')
        .replace('REMOTE_RUNNER_CHILD: "1"', 'REMOTE_RUNNER_CHILD: ""'),
    );

    expect(manifest.profiles[0]?.workload.command).toEqual(["./scripts/verify", ""]);
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
    expect(() => loadManifestText(validManifest.replace(before, after))).toThrow(/unsafe repository path/);
  });

  it.each([
    "/absolute/**/package.json",
    "../**/package.json",
    "packages/../package.json",
    "C:/packages/*/package.json",
    ":(top)**/package.json",
    "packages\\*/package.json",
  ])("rejects unsafe fingerprint pattern %s", (pattern) => {
    expect(() =>
      loadManifestText(
        validManifest.replace(
          "fingerprint: [package.json, pnpm-lock.yaml]",
          `fingerprint: { files: [package.json], patterns: [${JSON.stringify(pattern)}] }`,
        ),
      ),
    ).toThrow(/fingerprint pattern/u);
  });

  it.each(["/tmp/bundle", "../bundle", "runner/./bundle", "runner//bundle", "runner\\bundle", "runner/\0bundle"])(
    "rejects unsafe bootstrap artifact %s",
    (artifact) => {
      expect(() =>
        loadManifestText(
          validArtifactManifest.replace("vendor/dev-standards/runner/dist/verify-runner.mjs", JSON.stringify(artifact)),
        ),
      ).toThrow(/bootstrap artifact|unsafe repository path/u);
    },
  );
});
