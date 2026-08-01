export type UnavailableReason =
  "dns" | "host-key" | "authentication" | "transport" | "remote-shell" | "capacity" | "bootstrap";

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: UnavailableReason };

export function classifySshFailure(stderr: string, exitCode: number): UnavailableReason {
  if (exitCode !== 255) return "remote-shell";
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

async function attempt(probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
  try {
    return await probe();
  } catch {
    return { ok: false, reason: "transport" };
  }
}

export async function probeTwice(probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const first = await attempt(probe);
  if (first.ok) return first;
  return attempt(probe);
}

export function capacityProbe(stdout: string, minimumFreeBytes: number): ProbeResult {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) {
    throw new Error("minimum free bytes must be a positive safe integer");
  }
  const value = stdout.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return { ok: false, reason: "capacity" };
  const available = Number(value);
  return Number.isSafeInteger(available) && available >= minimumFreeBytes
    ? { ok: true }
    : { ok: false, reason: "capacity" };
}
