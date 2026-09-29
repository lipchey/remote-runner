import type { FailureClass } from "../run/prepare.js";

export type UnavailableReason =
  "dns" | "host-key" | "authentication" | "transport" | "remote-shell" | "capacity" | "bootstrap";

/* Takes the whole result rather than the code so no call site can classify without first answering
   "did the local ssh client even start?". A spawn failure (ENOENT, EMFILE, ENOMEM) never left the
   workstation and carries a manufactured code; read as `remote-shell` it sends the operator to
   `ssh <remote> true` for a fault the remote never saw. */
export function classifySshFailure(
  stderr: string,
  result: { readonly exitCode: number; readonly spawned: boolean },
): UnavailableReason {
  if (!result.spawned) return "transport";
  if (result.exitCode !== 255) return "remote-shell";
  if (/could not resolve hostname|name or service not known|nodename nor servname provided/iu.test(stderr)) {
    return "dns";
  }
  if (/remote host identification has changed|host key verification failed|no .* host key is known/iu.test(stderr)) {
    return "host-key";
  }
  if (/permission denied|authentication failed|too many authentication failures/iu.test(stderr)) {
    return "authentication";
  }
  if (
    /connection (?:timed out|refused|reset|closed)|no route to host|network is unreachable|operation timed out|connection to .* port .* timed out/iu.test(
      stderr,
    )
  ) {
    return "transport";
  }
  return "remote-shell";
}

export function failureClassOf(reason: UnavailableReason, result: { readonly spawned: boolean }): FailureClass {
  if (!result.spawned) return "local";
  if (reason === "dns" || reason === "transport") return "reachability";
  if (reason === "host-key" || reason === "authentication") return "security";
  return "remote";
}
