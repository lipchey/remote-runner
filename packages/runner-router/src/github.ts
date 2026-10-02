import type { Config } from "./config.js";
import type { InstallationToken, Runner } from "./decide.js";

export type Result<T> =
  { kind: "ok"; value: T } | { kind: "unknown"; reason: string } | { kind: "cooldown"; reason: string; until: number };
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface Deadline {
  timeout(milliseconds: number): AbortSignal;
}
export const realDeadline: Deadline = { timeout: (milliseconds) => AbortSignal.timeout(milliseconds) };
export interface GitHubPort {
  token: InstallationToken | null;
  list(signal: AbortSignal): Promise<Result<Runner[]>>;
  get(runner: Runner, signal: AbortSignal): Promise<Result<Runner>>;
  add(runner: Runner, labels: string[], signal: AbortSignal): Promise<Result<void>>;
  remove(runner: Runner, label: string, signal: AbortSignal): Promise<Result<void>>;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function der(tag: number, bytes: number[]): number[] {
  const length: number[] = [];
  for (let size = bytes.length; size > 0; size >>>= 8) length.unshift(size & 255);
  return [tag, ...(bytes.length < 128 ? [bytes.length] : [0x80 | length.length, ...length]), ...bytes];
}
export async function appJwt(config: Config, now: number): Promise<string> {
  const pem = config.githubAppPrivateKey;
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----") && !pem.includes("-----BEGIN PRIVATE KEY-----"))
    throw new Error("Unsupported private key");
  let bytes = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (character) => character.charCodeAt(0));
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    bytes = new Uint8Array(
      der(0x30, [2, 1, 0, 0x30, 0x0d, 6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1, 5, 0, ...der(4, [...bytes])]),
    );
  }
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const encoder = new TextEncoder();
  const seconds = Math.floor(now / 1000);
  const content = [
    { alg: "RS256", typ: "JWT" },
    { iat: seconds - 60, exp: seconds + 540, iss: config.githubAppId },
  ]
    .map((value) => base64url(encoder.encode(JSON.stringify(value))))
    .join(".");
  return `${content}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(content))))}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function parseRunner(value: unknown): Runner | undefined {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    typeof value.name !== "string" ||
    (value.status !== "online" && value.status !== "offline") ||
    typeof value.busy !== "boolean" ||
    !Array.isArray(value.labels)
  )
    return undefined;
  const labels: string[] = [];
  for (const label of value.labels as unknown[]) {
    if (!record(label) || typeof label.name !== "string") return undefined;
    labels.push(label.name);
  }
  return { id: Number(value.id), name: value.name, status: value.status, busy: value.busy, labels };
}
const unknown = (reason: string): Result<never> => ({ kind: "unknown", reason });

export class GitHub implements GitHubPort {
  token: InstallationToken | null = null;
  constructor(
    private readonly config: Config,
    private readonly fetch: Fetch,
    private readonly now: () => number,
    private readonly deadline: Deadline = realDeadline,
  ) {}
  private get base(): string {
    return `https://api.github.com/repos/${this.config.repo}/actions/runners`;
  }

  private failure(response: Response): Result<never> {
    const retry = response.headers.get("retry-after");
    if (
      response.status === 429 ||
      (response.status === 403 && (retry !== null || response.headers.get("x-ratelimit-remaining") === "0"))
    ) {
      const now = this.now();
      const retryAt = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
      const resetAt =
        response.headers.get("x-ratelimit-remaining") === "0"
          ? Number(response.headers.get("x-ratelimit-reset")) * 1000
          : 0;
      return {
        kind: "cooldown",
        reason: `GitHub HTTP ${response.status}`,
        until: Math.max(now + 60_000, Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(resetAt) ? resetAt : 0),
      };
    }
    return unknown(`GitHub HTTP ${response.status}`);
  }

  private async raw(
    url: string,
    method: string,
    authorization: string,
    signal: AbortSignal,
    body?: string,
  ): Promise<Result<Response>> {
    if (signal.aborted) return unknown("GitHub deadline expired");
    try {
      const response = await this.fetch(url, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${authorization}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "runner-router",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([signal, this.deadline.timeout(5000)]),
      });
      return { kind: "ok", value: response };
    } catch {
      return unknown("GitHub fetch failed or timed out");
    }
  }

  private async installationToken(signal: AbortSignal): Promise<Result<string>> {
    if (this.token && this.now() < this.token.expiresAt - 300_000) return { kind: "ok", value: this.token.value };
    this.token = null;
    if (signal.aborted) return unknown("GitHub deadline expired");
    try {
      const jwt = await appJwt(this.config, this.now());
      const result = await this.raw(
        `https://api.github.com/app/installations/${this.config.githubAppInstallationId}/access_tokens`,
        "POST",
        jwt,
        signal,
      );
      if (result.kind !== "ok") return result;
      if (!result.value.ok) return this.failure(result.value);
      const body: unknown = await result.value.json();
      if (!record(body) || typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string")
        return unknown("Invalid installation token response");
      const expiresAt = Date.parse(body.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now() + 300_000)
        return unknown("Installation token expires too soon");
      this.token = { value: body.token, expiresAt };
      return { kind: "ok", value: body.token };
    } catch {
      return unknown("Installation token failed");
    }
  }

  private async request(
    url: string,
    method: string,
    signal: AbortSignal,
    body?: string,
    absentOk = false,
  ): Promise<Result<Response>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.installationToken(signal);
      if (token.kind !== "ok") return token;
      const result = await this.raw(url, method, token.value, signal, body);
      if (result.kind !== "ok") return result;
      const response = result.value;
      if (response.status === 401) {
        this.token = null;
        if (attempt === 0) continue;
      }
      return response.ok || (absentOk && response.status === 404) ? result : this.failure(response);
    }
    return unknown("GitHub authentication failed");
  }

  async list(signal: AbortSignal): Promise<Result<Runner[]>> {
    const runners: Runner[] = [];
    const seen = new Set<string>();
    let url: string | undefined = `${this.base}?per_page=100`;
    let total: number | undefined;
    try {
      while (url) {
        const page = new URL(url);
        if (
          page.origin !== "https://api.github.com" ||
          (page.pathname !== new URL(this.base).pathname &&
            !/^\/repositories\/\d+\/actions\/runners$/.test(page.pathname)) ||
          seen.has(url) ||
          page.searchParams.get("per_page") !== "100"
        )
          return unknown("Unsafe or repeated roster page");
        seen.add(url);
        const result = await this.request(url, "GET", signal);
        if (result.kind !== "ok") return result;
        const body: unknown = await result.value.json();
        if (
          !record(body) ||
          !Number.isSafeInteger(body.total_count) ||
          Number(body.total_count) < 0 ||
          !Array.isArray(body.runners)
        )
          return unknown("Invalid roster response");
        if (total !== undefined && total !== body.total_count) return unknown("Roster count changed during pagination");
        total = Number(body.total_count);
        for (const value of body.runners as unknown[]) {
          const runner = parseRunner(value);
          if (!runner || runners.some((entry) => entry.id === runner.id || entry.name === runner.name))
            return unknown("Invalid or duplicate roster runner");
          runners.push(runner);
        }
        if (runners.length > total) return unknown("Incomplete roster");
        const link = result.value.headers.get("Link");
        url = link
          ?.split(",")
          .find((part) => /;\s*rel="next"/.test(part))
          ?.match(/<([^>]+)>/)?.[1];
        if (link && /rel="next"/.test(link) && !url) return unknown("Invalid roster next link");
      }
      return runners.length === total ? { kind: "ok", value: runners } : unknown("Incomplete roster");
    } catch {
      return unknown("Roster parsing failed or timed out");
    }
  }

  async get(runner: Runner, signal: AbortSignal): Promise<Result<Runner>> {
    try {
      const result = await this.request(`${this.base}/${runner.id}`, "GET", signal);
      if (result.kind !== "ok") return result;
      const value = parseRunner(await result.value.json());
      return value && value.id === runner.id ? { kind: "ok", value } : unknown("Invalid runner response");
    } catch {
      return unknown("Runner parsing failed or timed out");
    }
  }

  private guard(runner: Runner, labels: string[]): void {
    if (
      runner.name !== this.config.laptopRunner ||
      labels.some((label) => !this.config.laptopAdmissionLabels.some((allowed) => allowed === label))
    )
      throw new Error("Unsafe runner label mutation");
  }
  async add(runner: Runner, labels: string[], signal: AbortSignal): Promise<Result<void>> {
    this.guard(runner, labels);
    const result = await this.request(`${this.base}/${runner.id}/labels`, "POST", signal, JSON.stringify({ labels }));
    return result.kind === "ok" ? { kind: "ok", value: undefined } : result;
  }
  async remove(runner: Runner, label: string, signal: AbortSignal): Promise<Result<void>> {
    this.guard(runner, [label]);
    const result = await this.request(
      `${this.base}/${runner.id}/labels/${encodeURIComponent(label)}`,
      "DELETE",
      signal,
      undefined,
      true,
    );
    return result.kind === "ok" ? { kind: "ok", value: undefined } : result;
  }
}
