import { describe, expect, it } from "vitest";

import { planWorkspaceRetention } from "../../../src/workspace/retention.js";

const minute = 60_000;
const nowMs = 2_000_000_000_000;

function identity(value: number): string {
  return value.toString(16).padStart(24, "0");
}

describe("planWorkspaceRetention", () => {
  it("reserves the current identity, keeps the newest valid identities, and protects grace entries", () => {
    const current = identity(1);
    const recent = identity(2);
    const newest = identity(3);
    const nextNewest = identity(4);
    const stale = identity(5);
    const legacyWithoutMarker = identity(6);

    const plan = planWorkspaceRetention(
      [
        { identity: current, activityMs: nowMs - 10_000 * minute },
        { identity: recent, activityMs: nowMs - 30 * minute },
        { identity: newest, activityMs: nowMs - 61 * minute },
        { identity: nextNewest, activityMs: nowMs - 62 * minute },
        { identity: stale, activityMs: nowMs - 63 * minute },
        { identity: legacyWithoutMarker, activityMs: nowMs - 64 * minute },
        { identity: "../../hostile", activityMs: nowMs },
        { identity: "ABCDEFABCDEFABCDEFABCDEF", activityMs: nowMs },
        { identity: "abcdef", activityMs: nowMs },
      ],
      current,
      { keep: 3, graceMinutes: 60 },
      nowMs,
    );

    expect(plan).toEqual({
      retained: [current, recent, newest],
      graceProtected: [],
      candidates: [nextNewest, stale, legacyWithoutMarker],
    });
  });

  it("grace-protects recent identities that fall outside the keep budget", () => {
    const current = identity(10);
    const recent = identity(11);
    const kept = identity(12);
    const stale = identity(13);

    expect(
      planWorkspaceRetention(
        [
          { identity: current, activityMs: nowMs - 4 * minute },
          { identity: kept, activityMs: nowMs - 2 * minute },
          { identity: recent, activityMs: nowMs - 30 * minute },
          { identity: stale, activityMs: nowMs - 61 * minute },
        ],
        current,
        { keep: 2, graceMinutes: 60 },
        nowMs,
      ),
    ).toEqual({
      retained: [current, kept],
      graceProtected: [recent],
      candidates: [stale],
    });
  });

  it("sorts equal timestamps by identity and rejects unsafe numeric input", () => {
    const current = identity(20);
    const lower = identity(21);
    const higher = identity(22);

    expect(
      planWorkspaceRetention(
        [
          { identity: higher, activityMs: nowMs - 2 * minute },
          { identity: lower, activityMs: nowMs - 2 * minute },
          { identity: current, activityMs: nowMs - minute },
        ],
        current,
        { keep: 2, graceMinutes: 1 },
        nowMs,
      ),
    ).toEqual({
      retained: [current, lower],
      graceProtected: [],
      candidates: [higher],
    });

    expect(() =>
      planWorkspaceRetention(
        [{ identity: current, activityMs: Number.NaN }],
        current,
        { keep: 1, graceMinutes: 1 },
        nowMs,
      ),
    ).toThrow(/activity/i);
    expect(() => planWorkspaceRetention([], current, { keep: 1, graceMinutes: 1 }, Number.MAX_VALUE)).toThrow(/now/i);
  });
});
