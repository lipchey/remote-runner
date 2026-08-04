import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_PROBES } from "../../src/diagnostics/doctor.js";

describe("remote-runner operations guide", () => {
  it("documents every stable reason with its read-only doctor command", async () => {
    const runbook = await readFile(
      new URL("../../docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md", import.meta.url),
      "utf8",
    );

    for (const probe of DIAGNOSTIC_PROBES) {
      expect(runbook).toContain(`\`${probe.reason}\``);
      expect(runbook).toContain(probe.command.join(" "));
    }
  });

  it("covers every required symptom and puts dry-run before every apply example", async () => {
    const runbook = await readFile(
      new URL("../../docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md", import.meta.url),
      "utf8",
    );
    for (const topic of [
      "SSH and Tailscale",
      "Host key",
      "Mutagen",
      "Workspace",
      "Disk capacity",
      "Bootstrap",
      "Telegram",
      "Workstation reboot",
      "Controller crash",
      "Corrupt state",
      "Upgrade",
      "Uninstall",
      "Privacy-safe support bundle",
      "Sync canary",
    ])
      expect(runbook).toContain(topic);

    const lines = runbook.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes("remote-runner repair") || !line.includes("--apply")) continue;
      expect(
        lines
          .slice(Math.max(0, index - 8), index)
          .some((candidate) => candidate.includes("remote-runner repair") && candidate.includes("--dry-run")),
      ).toBe(true);
    }
  });
});
