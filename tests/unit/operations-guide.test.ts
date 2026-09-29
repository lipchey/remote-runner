import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_PROBES } from "../../src/diagnostics/doctor.js";
import { NOTIFICATION_REASONS } from "../../src/notifications/outage.js";

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

  it("keeps a read-only diagnosis for every reason the runner can report, probe or not", async () => {
    const runbook = await readFile(
      new URL("../../docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md", import.meta.url),
      "utf8",
    );

    /* The probe table is a strict subset of the reason set: a reason with no implementable read-only
       check has no probe, so the runbook row is the only next step its operator gets. Keyed on the
       reason set rather than on the probes, because the reasons that need this most are exactly the
       ones no probe iterates. */
    for (const reason of NOTIFICATION_REASONS) {
      expect(runbook).toContain(`| \`${reason}\``);
    }
  });

  it("covers every required symptom", async () => {
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
  });

  it("documents remote fallback operation and rollback", async () => {
    const runbook = await readFile(
      new URL("../../docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md", import.meta.url),
      "utf8",
    );

    for (const topic of [
      "Remote fallback",
      "Rollback from remote fallback",
      "remote-runner resolve",
      "REMOTE_RUNNER_SELECTED_PROFILE",
      "REMOTE_RUNNER_REMOTE_LABEL",
    ])
      expect(runbook).toContain(topic);
    expect(runbook).toMatch(/^\| `3`\s+\|/mu);
    expect(runbook).toMatch(/^\| `4`\s+\|/mu);
  });
});
