export interface EnvironmentIdentity {
  readonly node: string;
  readonly packageManager: string;
  readonly uv?: string;
  readonly gitleaks?: string;
}

export interface GitlinkIdentity {
  readonly path: string;
  readonly oid: string;
}

export interface FingerprintRuntime {
  readFile(path: string): Promise<Uint8Array>;
  listGitlinks(): Promise<readonly GitlinkIdentity[]>;
  sha256(contents: Uint8Array): Promise<string>;
}

export interface FingerprintInput {
  readonly environment: EnvironmentIdentity;
  readonly files: readonly string[];
}

const encoder = new TextEncoder();
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function safeRelative(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function field(value: string, label: string): Uint8Array {
  if (value.length === 0 || /\u0000/u.test(value)) throw new Error(`${label} must be a non-empty safe value`);
  const contents = encoder.encode(value);
  return encoder.encode(`${contents.byteLength}:` + value);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function environmentRecord(environment: EnvironmentIdentity): Record<string, string> {
  const result: Record<string, string> = {
    node: environment.node,
    packageManager: environment.packageManager,
  };
  if (environment.uv !== undefined) result.uv = environment.uv;
  if (environment.gitleaks !== undefined) result.gitleaks = environment.gitleaks;
  for (const [name, value] of Object.entries(result)) field(value, `environment ${name}`);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)));
}

export async function dependencyFingerprint(runtime: FingerprintRuntime, input: FingerprintInput): Promise<string> {
  const uniqueFiles = new Set(input.files);
  if (uniqueFiles.size !== input.files.length) throw new Error("fingerprint file list contains a duplicate");
  for (const path of input.files) if (!safeRelative(path)) throw new Error("fingerprint file must be a safe relative path");
  const gitlinks = [...await runtime.listGitlinks()].sort((left, right) => compareText(left.path, right.path));
  const seenGitlinks = new Set<string>();
  for (const gitlink of gitlinks) {
    if (!safeRelative(gitlink.path) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(gitlink.oid) || seenGitlinks.has(gitlink.path)) {
      throw new Error("fingerprint gitlink is malformed or duplicated");
    }
    seenGitlinks.add(gitlink.path);
  }
  const parts: Uint8Array[] = [field(JSON.stringify(environmentRecord(input.environment)), "environment")];
  for (const path of [...input.files].sort()) {
    const contents = await runtime.readFile(path);
    parts.push(field("file", "record kind"), field(path, "file path"), field(String(contents.byteLength), "file length"), contents);
  }
  for (const gitlink of gitlinks) {
    parts.push(field("gitlink", "record kind"), field(gitlink.path, "gitlink path"), field(gitlink.oid, "gitlink OID"));
  }
  const digest = await runtime.sha256(concatenate(parts));
  if (digest.length === 0 || /\u0000/u.test(digest)) throw new Error("fingerprint hash is invalid");
  return `sha256:${digest}`;
}
