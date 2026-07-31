import { describe, expect, it } from "vitest";

import { repair, type RepairAction, type RepairReceipt, type RepairRuntime } from "../../../src/diagnostics/repair.js";

class FakeRepairRuntime implements RepairRuntime {
  readonly identity = "worktree-abc123";
  readonly identityRoot = `/state/profiles/${this.identity}`;
  readonly mutations: RepairAction[] = [];
  receipt: RepairReceipt | undefined;
  actions: RepairAction[] = [
    { id: "session-recreate", target: `${this.identityRoot}/mutagen/session.json`, destructive: true },
    { id: "workspace-reconcile", target: `${this.identityRoot}/workspace`, destructive: false },
  ];

  async inspect() { return this.actions; }
  async readDryRun() { return this.receipt; }
  async writeDryRun(receipt: RepairReceipt) { this.receipt = receipt; }
  async apply(action: RepairAction) { this.mutations.push(action); }
  now() { return "2026-07-31T12:00:00.000Z"; }
}

describe("repair", () => {
  it("dry-run describes one identity and performs no repair mutation", async () => {
    const runtime = new FakeRepairRuntime();

    const plan = await repair(runtime, "verify-full", { apply: false });

    expect(plan.actions.every((action) => action.target.includes(runtime.identity))).toBe(true);
    expect(runtime.mutations).toHaveLength(0);
    expect(runtime.receipt?.planHash).toBe(plan.planHash);
  });

  it("refuses apply until the exact current plan has a prior dry-run receipt", async () => {
    const runtime = new FakeRepairRuntime();

    await expect(repair(runtime, "verify-full", { apply: true })).rejects.toThrow(
      "run repair --dry-run first",
    );
    expect(runtime.mutations).toHaveLength(0);

    await repair(runtime, "verify-full", { apply: false });
    runtime.actions = [{ id: "workspace-reconcile", target: `${runtime.identityRoot}/changed`, destructive: false }];
    await expect(repair(runtime, "verify-full", { apply: true })).rejects.toThrow(
      "repair plan changed",
    );
    expect(runtime.mutations).toHaveLength(0);
  });

  it("applies an unchanged confined plan only after dry-run", async () => {
    const runtime = new FakeRepairRuntime();

    const preview = await repair(runtime, "verify-full", { apply: false });
    const applied = await repair(runtime, "verify-full", { apply: true });

    expect(applied.planHash).toBe(preview.planHash);
    expect(runtime.mutations).toEqual(preview.actions);
  });

  it("rejects sibling, traversal, duplicate, and unknown repair targets before recording preview", async () => {
    for (const actions of [
      [{ id: "bad", target: "/state/profiles/sibling/file", destructive: true }],
      [{ id: "bad", target: `/state/profiles/${new FakeRepairRuntime().identity}/../sibling`, destructive: true }],
      [
        { id: "dup", target: `/state/profiles/${new FakeRepairRuntime().identity}/one`, destructive: true },
        { id: "dup", target: `/state/profiles/${new FakeRepairRuntime().identity}/two`, destructive: true },
      ],
    ] satisfies RepairAction[][]) {
      const runtime = new FakeRepairRuntime();
      runtime.actions = actions;
      await expect(repair(runtime, "verify-full", { apply: false })).rejects.toThrow();
      expect(runtime.receipt).toBeUndefined();
      expect(runtime.mutations).toHaveLength(0);
    }
  });
});
