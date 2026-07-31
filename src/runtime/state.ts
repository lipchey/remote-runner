import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface StateFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array, mode: number): Promise<void>;
  sync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

interface StateEnvelope<T> {
  readonly schemaVersion: number;
  readonly data: T;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function errorCode(caught: unknown): string | undefined {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { code?: unknown }).code)
    : undefined;
}

function parseEnvelope(contents: Uint8Array, schemaVersion: number): StateEnvelope<unknown> {
  const parsed: unknown = JSON.parse(decoder.decode(contents));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("state envelope must be an object");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "data" || keys[1] !== "schemaVersion") {
    throw new Error("state envelope has an invalid shape");
  }
  const envelope = parsed as { readonly schemaVersion?: unknown; readonly data?: unknown };
  if (!Number.isSafeInteger(envelope.schemaVersion) || envelope.schemaVersion !== schemaVersion) {
    throw new Error(`unsupported state schema version: ${String(envelope.schemaVersion)}`);
  }
  return { schemaVersion, data: envelope.data };
}

async function retainCorruptState(
  files: StateFileSystem,
  path: string,
  uniqueToken: () => string,
  cause: unknown,
): Promise<never> {
  const diagnosticPath = `${path}.corrupt-${uniqueToken()}`;
  await files.rename(path, diagnosticPath);
  throw new Error(`corrupt state retained at ${diagnosticPath}`, { cause });
}

export async function readVersionedState<T>(
  files: StateFileSystem,
  path: string,
  schemaVersion: number,
  validate: (value: unknown) => value is T,
  uniqueToken: () => string = randomUUID,
): Promise<T> {
  let contents: Uint8Array;
  try {
    contents = await files.readFile(path);
  } catch (caught) {
    throw caught;
  }

  let envelope: StateEnvelope<unknown>;
  try {
    envelope = parseEnvelope(contents, schemaVersion);
    if (!validate(envelope.data)) throw new Error("state data has an invalid shape");
  } catch (caught) {
    return retainCorruptState(files, path, uniqueToken, caught);
  }
  return envelope.data;
}

export async function writeVersionedState<T>(
  files: StateFileSystem,
  path: string,
  schemaVersion: number,
  data: T,
  uniqueToken: () => string = randomUUID,
): Promise<void> {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("state schema version must be a positive safe integer");
  }

  let existing: Uint8Array | undefined;
  try {
    existing = await files.readFile(path);
  } catch (caught) {
    if (errorCode(caught) !== "ENOENT") throw caught;
  }
  if (existing !== undefined) {
    try {
      parseEnvelope(existing, schemaVersion);
    } catch {
      const diagnosticPath = `${path}.corrupt-${uniqueToken()}`;
      await files.rename(path, diagnosticPath);
    }
  }

  const serialized = JSON.stringify({ schemaVersion, data } satisfies StateEnvelope<T>);
  if (serialized === undefined) throw new Error("state data is not JSON serializable");
  const temporaryPath = `${path}.tmp-${uniqueToken()}`;
  let temporaryCreated = false;
  try {
    await files.writeFile(temporaryPath, encoder.encode(serialized), 0o600);
    temporaryCreated = true;
    await files.sync(temporaryPath);
    await files.rename(temporaryPath, path);
    temporaryCreated = false;
    await files.sync(dirname(path));
  } catch (caught) {
    if (temporaryCreated || errorCode(caught) !== "EEXIST") {
      try {
        await files.remove(temporaryPath);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") {
          throw new AggregateError([caught, cleanupError], "state write and temp cleanup failed");
        }
      }
    }
    throw caught;
  }
}
