import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALL_RECEIPT_NAME = ".remote-runner-receipt.json";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const APP_IDENTITY = /^[0-9a-f]{24}$/u;

export interface InstallReceipt {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly appIdentity: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("install receipt must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseInstallReceipt(contents: string): InstallReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (caught) {
    throw new Error("install receipt must be valid JSON", { cause: caught });
  }
  const value = record(parsed);
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["appIdentity", "schemaVersion", "version"].join("\0")) {
    throw new Error("install receipt fields are invalid");
  }
  if (value.schemaVersion !== 1) throw new Error("install receipt schema version must be 1");
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new Error("install receipt version must be exact semver");
  }
  if (typeof value.appIdentity !== "string" || !APP_IDENTITY.test(value.appIdentity)) {
    throw new Error("install receipt app identity is invalid");
  }
  return { schemaVersion: 1, version: value.version, appIdentity: value.appIdentity };
}

export function formatInstallReceipt(receipt: InstallReceipt): string {
  const validated = parseInstallReceipt(JSON.stringify(receipt));
  return `${JSON.stringify(validated)}\n`;
}

export function formatInstallVersion(receipt: InstallReceipt): string {
  const validated = parseInstallReceipt(JSON.stringify(receipt));
  return `remote-runner ${validated.version} (app ${validated.appIdentity})`;
}

export function packageVersion(contents: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (caught) {
    throw new Error("install source package.json must be valid JSON", { cause: caught });
  }
  const value = record(parsed);
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new Error("install source package version must be exact semver");
  }
  return value.version;
}

export async function readInstalledReceipt(mainModuleUrl: string): Promise<InstallReceipt> {
  const appRoot = join(dirname(fileURLToPath(mainModuleUrl)), "..");
  return parseInstallReceipt(await readFile(join(appRoot, INSTALL_RECEIPT_NAME), "utf8"));
}
