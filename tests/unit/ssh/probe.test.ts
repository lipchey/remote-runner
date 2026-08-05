import { describe, expect, it } from "vitest";

import { classifySshFailure } from "../../../src/ssh/probe.js";

describe("SSH availability reasons", () => {
  it.each([
    ["ssh: Could not resolve hostname pop-os: nodename nor servname provided", "dns"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host-key"],
    ["admin@pop-os: Permission denied (publickey).", "authentication"],
    ["ssh: connect to host pop-os port 22: Connection timed out", "transport"],
    ["bash: node: command not found", "remote-shell"],
  ] as const)("classifies stderr without exposing it: %s", (stderr, reason) => {
    expect(classifySshFailure(stderr, { exitCode: 255, spawned: true })).toBe(reason);
  });

  it.each(["Permission denied (publickey).", "Connection closed by remote host", "Host key verification failed."])(
    "treats remote command stderr as remote-shell for non-255 exit: %s",
    (stderr) => {
      expect(classifySshFailure(stderr, { exitCode: 23, spawned: true })).toBe("remote-shell");
    },
  );

  /* The failure never left the workstation: the local ssh binary could not be spawned, and its
     manufactured exit code is whatever the process layer put there. Diagnosed as `remote-shell` it
     sends the operator to `ssh <remote> true` for a remote that was never contacted. */
  it.each([-2, 23, 255])("refuses to diagnose the remote when the ssh client never started (exit %i)", (exitCode) => {
    expect(classifySshFailure("bash: node: command not found", { exitCode, spawned: false })).toBe("transport");
  });
});
