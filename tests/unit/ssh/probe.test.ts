import { describe, expect, it, vi } from "vitest";

import { capacityProbe, classifySshFailure, probeTwice, type ProbeResult } from "../../../src/ssh/probe.js";

describe("SSH availability reasons", () => {
  it.each([
    ["ssh: Could not resolve hostname pop-os: nodename nor servname provided", "dns"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host-key"],
    ["admin@pop-os: Permission denied (publickey).", "authentication"],
    ["ssh: connect to host pop-os port 22: Connection timed out", "transport"],
    ["bash: node: command not found", "remote-shell"],
  ] as const)("classifies stderr without exposing it: %s", (stderr, reason) => {
    expect(classifySshFailure(stderr, 255)).toBe(reason);
  });

  it.each(["Permission denied (publickey).", "Connection closed by remote host", "Host key verification failed."])(
    "treats remote command stderr as remote-shell for non-255 exit: %s",
    (stderr) => {
      expect(classifySshFailure(stderr, 23)).toBe("remote-shell");
    },
  );

  it("does not declare an outage after one transient failure", async () => {
    const once = vi
      .fn<() => Promise<ProbeResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "transport" })
      .mockResolvedValueOnce({ ok: true });

    expect(await probeTwice(once)).toEqual({ ok: true });
    expect(once).toHaveBeenCalledTimes(2);
  });

  it("accepts the first success without requiring a second probe", async () => {
    const once = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue({ ok: true });
    expect(await probeTwice(once)).toEqual({ ok: true });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("reports only the second reason after two failed probes", async () => {
    const once = vi
      .fn<() => Promise<ProbeResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "dns" })
      .mockResolvedValueOnce({ ok: false, reason: "authentication" });

    expect(await probeTwice(once)).toEqual({ ok: false, reason: "authentication" });
  });

  it.each([
    ["4096\n", 4096, { ok: true }],
    ["4095\n", 4096, { ok: false, reason: "capacity" }],
    ["not-a-number\n", 1, { ok: false, reason: "capacity" }],
    ["9007199254740992\n", 1, { ok: false, reason: "capacity" }],
  ] as const)("validates minimum free bytes from %j", (stdout, minimum, expected) => {
    expect(capacityProbe(stdout, minimum)).toEqual(expected);
  });
});
