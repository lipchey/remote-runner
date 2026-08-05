const encoder = new TextEncoder();
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;
export const MAX_SECRET_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;

export const SECRET_FRAME_MAGIC = encoder.encode("RRSE1\0");

export interface SecretFrame {
  readonly stdin: Uint8Array;
  readonly metadata: {
    readonly names: readonly string[];
    readonly bytes: number;
  };
}

export function validateAllowlist(allow: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const name of allow) {
    if (!SECRET_NAME.test(name)) throw new Error("secret allowlist contains an invalid name");
    if (result.has(name)) throw new Error("secret allowlist contains a duplicate");
    result.add(name);
  }
  return result;
}

export function encodeSecretFrame(values: Readonly<Record<string, string>>, allow: readonly string[]): SecretFrame {
  const allowed = validateAllowlist(allow);
  const entries = Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, value] of entries) {
    if (!SECRET_NAME.test(name)) throw new Error("secret frame contains an invalid name");
    if (!allowed.has(name)) throw new Error(`unallowlisted secret: ${name}`);
    if (typeof value !== "string" || value.includes("\0") || encoder.encode(value).byteLength > MAX_SECRET_BYTES) {
      throw new Error("secret frame contains an invalid value");
    }
  }
  const payload = encoder.encode(JSON.stringify(entries));
  const stdin = new Uint8Array(SECRET_FRAME_MAGIC.byteLength + payload.byteLength);
  stdin.set(SECRET_FRAME_MAGIC, 0);
  stdin.set(payload, SECRET_FRAME_MAGIC.byteLength);
  if (stdin.byteLength > MAX_FRAME_BYTES) throw new Error("secret frame exceeds the total size limit");
  return {
    stdin,
    metadata: { names: entries.map(([name]) => name), bytes: stdin.byteLength },
  };
}
