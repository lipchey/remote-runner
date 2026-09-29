import { describe, expect, it } from "vitest";

import { classifySshFailure, failureClassOf } from "../../../src/ssh/probe.js";

describe("SSH availability reasons", () => {
  it.each([
    ["ssh: Could not resolve hostname pop-os: nodename nor servname provided", "dns", "reachability"],
    ["ssh: connect to host pop-os port 22: Connection timed out", "transport", "reachability"],
    ["ssh: connect to host pop-os port 22: Connection refused", "transport", "reachability"],
    ["ssh: connect to host pop-os port 22: No route to host", "transport", "reachability"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host-key", "security"],
    ["Host key verification failed.", "host-key", "security"],
    ["admin@pop-os: Permission denied (publickey).", "authentication", "security"],
    ["bash: node: command not found", "remote-shell", "remote"],
  ] as const)("classifies stderr without exposing it: %s", (stderr, reason, failureClass) => {
    const result = { exitCode: 255, spawned: true };
    expect(classifySshFailure(stderr, result)).toBe(reason);
    expect(failureClassOf(reason, result)).toBe(failureClass);
  });

  it.each(["ENOENT", "EMFILE"])("classifies an unspawned ssh client (%s) as local", (spawnErrorCode) => {
    const result = { exitCode: 127, spawned: false, spawnErrorCode };
    const reason = classifySshFailure("", result);

    expect(reason).toBe("transport");
    expect(failureClassOf(reason, result)).toBe("local");
  });

  it("classifies an ordinary remote command failure as remote", () => {
    const result = { exitCode: 1, spawned: true };
    const reason = classifySshFailure("", result);

    expect(reason).toBe("remote-shell");
    expect(failureClassOf(reason, result)).toBe("remote");
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
