export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ROTATED_FILES = 3;
const REDACTED = "[REDACTED]";

export interface LogFileSystem {
  appendFile(path: string, contents: Uint8Array, mode: number): Promise<void>;
  stat(path: string): Promise<{ readonly size: number }>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface JsonlLogger {
  registerSecret(value: string): void;
  write(record: unknown): Promise<void>;
}

interface JsonlLoggerOptions {
  readonly maxBytes?: number;
}

function errorCode(caught: unknown): string | undefined {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { code?: unknown }).code)
    : undefined;
}

async function ignoreMissing(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (caught) {
    if (errorCode(caught) !== "ENOENT") throw caught;
  }
}

function redactUrlCredentials(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s"'<>]+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username.length === 0 && url.password.length === 0) return candidate;
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

function sanitizeString(value: string, secrets: ReadonlySet<string>): string {
  const redactSecrets = (input: string): string => {
    let output = input;
    for (const secret of secrets) output = output.replaceAll(secret, REDACTED);
    return output;
  };
  let sanitized = redactUrlCredentials(value);
  sanitized = redactSecrets(sanitized);
  sanitized = redactUrlCredentials(sanitized);
  return redactSecrets(sanitized);
}

function sanitize(value: unknown, secrets: ReadonlySet<string>, seen: Set<object>): unknown {
  if (typeof value === "string") return sanitizeString(value, secrets);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[FUNCTION]";
  if (typeof value === "symbol") return "[SYMBOL]";
  if (value === undefined) return null;
  if (seen.has(value)) throw new Error("log record must not contain cycles");
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return "[ACCESSOR]";
        return sanitize(descriptor.value, secrets, seen);
      });
    }
    const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      sanitized[sanitizeString(key, secrets)] =
        "value" in descriptor ? sanitize(descriptor.value, secrets, seen) : "[ACCESSOR]";
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function createJsonlLogger(
  files: LogFileSystem,
  path: string,
  options: JsonlLoggerOptions = {},
): JsonlLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("log maxBytes must be a positive safe integer");
  }
  const secrets = new Set<string>();
  let pending: Promise<void> = Promise.resolve();

  const rotate = async (): Promise<void> => {
    await ignoreMissing(() => files.remove(`${path}.${DEFAULT_ROTATED_FILES}`));
    for (let index = DEFAULT_ROTATED_FILES - 1; index >= 1; index--) {
      await ignoreMissing(() => files.rename(`${path}.${index}`, `${path}.${index + 1}`));
    }
    await ignoreMissing(() => files.rename(path, `${path}.1`));
  };

  const writeOne = async (record: unknown): Promise<void> => {
    const serialized = JSON.stringify(sanitize(record, secrets, new Set()));
    if (serialized === undefined) throw new Error("log record is not JSON serializable");
    const contents = new TextEncoder().encode(`${serialized}\n`);
    if (contents.byteLength > maxBytes) throw new Error("log record exceeds maxBytes");

    let currentSize = 0;
    try {
      currentSize = (await files.stat(path)).size;
    } catch (caught) {
      if (errorCode(caught) !== "ENOENT") throw caught;
    }
    if (currentSize > 0 && currentSize + contents.byteLength > maxBytes) await rotate();
    await files.appendFile(path, contents, 0o600);
  };

  return {
    registerSecret(value: string): void {
      if (value.length === 0) throw new Error("registered secret must not be empty");
      secrets.add(value);
    },
    write(record: unknown): Promise<void> {
      const operation = pending.then(() => writeOne(record));
      pending = operation.catch(() => undefined);
      return operation;
    },
  };
}
