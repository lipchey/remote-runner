import { parseDocument } from "yaml";
import { parseEnv } from "node:util";

import { MAX_SECRET_BYTES, SECRET_NAME, validateAllowlist } from "./frame.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../ssh/client.js";

const MAX_PROVIDER_BYTES = 128 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface SecretProviderRuntime {
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

function validateCommand(command: readonly string[]): [string, ...string[]] {
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some((part) => typeof part !== "string" || part.includes("\0"))
  ) {
    throw new Error("secret provider command must be a non-empty safe argument array");
  }
  return command as [string, ...string[]];
}

function validateSecretValue(name: string, value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || encoder.encode(value).byteLength > MAX_SECRET_BYTES) {
    throw new Error(`secret ${name} has an invalid value`);
  }
  return value;
}

export function readDotenvSecrets(contents: string, allow: readonly string[]): Record<string, string> {
  const allowed = validateAllowlist(allow);
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(contents);
  } catch {
    throw new Error("dotenv secret source is malformed");
  }
  const values: Record<string, string> = {};
  for (const name of allowed) {
    if (!(name in parsed)) throw new Error(`required dotenv secret is missing: ${name}`);
    values[name] = validateSecretValue(name, parsed[name]);
  }
  return values;
}

export async function runSecretProvider(
  runtime: SecretProviderRuntime,
  command: readonly string[],
  allow: readonly string[],
): Promise<Record<string, string>> {
  const [executable, ...args] = validateCommand(command);
  const allowed = validateAllowlist(allow);
  const result = await runtime.run({ command: executable, args, maxOutputBytes: MAX_PROVIDER_BYTES });
  if (
    result.outputTruncated ||
    result.stdout.byteLength > MAX_PROVIDER_BYTES ||
    result.stderr.byteLength > MAX_PROVIDER_BYTES
  ) {
    throw new Error("secret provider exceeded the output limit");
  }
  if (result.exitCode !== 0) throw new Error(`secret provider failed with exit code ${result.exitCode}`);
  let text: string;
  try {
    text = decoder.decode(result.stdout);
  } catch {
    throw new Error("secret provider returned invalid UTF-8");
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("secret provider returned invalid or duplicate JSON keys");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("secret provider returned malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("secret provider must return one JSON object");
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!SECRET_NAME.test(name) || !allowed.has(name)) throw new Error(`unallowlisted secret: ${name}`);
    values[name] = validateSecretValue(name, value);
  }
  return values;
}
