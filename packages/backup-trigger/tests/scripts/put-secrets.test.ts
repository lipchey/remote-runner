import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/put-secrets.mjs");
const values = {
  GITHUB_BACKUP_DISPATCH_TOKEN: "fixture-dispatch-token",
  TELEGRAM_BOT_TOKEN: "fixture-telegram-token",
  TELEGRAM_CHAT_ID: "fixture-chat-id",
  CLOUDFLARE_REMOTE_RUNNER_TOKEN: "fixture-cloudflare-token",
  CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID: "fixture-cloudflare-account",
};
const secretNames = ["GITHUB_BACKUP_DISPATCH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].sort();
const envNames = ["PATH", "HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].sort();
let root: string;

function stub(name: string, source: string) {
  const path = join(root, "bin", name);
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
}

function run(flags: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, "--vault", join(root, "fixture.env.sops.yaml"), ...flags], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: root,
      SOPS_AGE_KEY_FILE: undefined,
      UNRELATED_SECRET: "fixture-unrelated-secret",
      ...extraEnv,
    },
  });
}

function expectNamesOnly(output: string) {
  for (const value of [...Object.values(values), "fixture-unrelated-secret"]) expect(output).not.toContain(value);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backup-trigger-secrets-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "values.json"), JSON.stringify(values));
  stub(
    "sops",
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, "sops.jsonl"))}, JSON.stringify({ args, env: process.env }) + '\\n');
const key = JSON.parse(args[args.indexOf('--extract') + 1])[0];
const values = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "values.json"))}, 'utf8'));
if (!Object.hasOwn(values, key)) process.exit(1);
process.stdout.write(values[key]);
`,
  );
  stub(
    "pnpm",
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, "upload.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, secrets: JSON.parse(fs.readFileSync(0, 'utf8')) }));
process.stdout.write('fixture-telegram-token');
process.exit(fs.existsSync(${JSON.stringify(join(root, "upload.fail"))}) ? 1 : 0);
`,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("backup secret upload", () => {
  it("uploads exactly three allowlisted secrets and four environment names", () => {
    const result = run();
    expect(result.status).toBe(0);
    const sent = JSON.parse(readFileSync(join(root, "upload.json"), "utf8")) as {
      args: string[];
      cwd: string;
      env: Record<string, string>;
      secrets: Record<string, string>;
    };
    expect(sent.args).toEqual(["exec", "wrangler", "secret", "bulk"]);
    expect(sent.cwd).toBe(resolve("."));
    expect(Object.keys(sent.secrets).sort()).toEqual(secretNames);
    expect(sent.secrets).toEqual({
      GITHUB_BACKUP_DISPATCH_TOKEN: values.GITHUB_BACKUP_DISPATCH_TOKEN,
      TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: values.TELEGRAM_CHAT_ID,
    });
    /* The macOS Node runtime adds this locale hint to explicit child environments. */
    expect(
      Object.keys(sent.env)
        .filter((name) => process.platform !== "darwin" || name !== "__CF_USER_TEXT_ENCODING")
        .sort(),
    ).toEqual(envNames);
    expect(sent.env.CLOUDFLARE_API_TOKEN).toBe(values.CLOUDFLARE_REMOTE_RUNNER_TOKEN);
    expect(sent.env.CLOUDFLARE_ACCOUNT_ID).toBe(values.CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID);
    const calls = readFileSync(join(root, "sops.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
    expect(calls).toHaveLength(5);
    expect(
      calls
        .map((call) => JSON.parse(call.args[4] ?? "") as string[])
        .flat()
        .sort(),
    ).toEqual(Object.keys(values).sort());
    for (const call of calls) {
      expect(call.args).toEqual([
        "-d",
        "--input-type",
        "dotenv",
        "--extract",
        call.args[4],
        join(root, "fixture.env.sops.yaml"),
      ]);
      expect(call.env.SOPS_AGE_KEY_FILE).toBe(join(root, ".config/sops/age/keys.txt"));
    }
    expectNamesOnly(result.stdout + result.stderr);
  });

  it("dry-run prints exact name lists without extraction or upload", () => {
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.replace("Secrets: ", "").split(", ").sort()).toEqual(secretNames);
    expect(lines[1]?.replace("Environment: ", "").split(", ").sort()).toEqual(envNames);
    expect(existsSync(join(root, "sops.jsonl"))).toBe(false);
    expect(existsSync(join(root, "upload.json"))).toBe(false);
    expectNamesOnly(result.stdout + result.stderr);
  });

  it("honors the explicit age key file", () => {
    const keyFile = join(root, "custom-age-keys.txt");
    expect(run([], { SOPS_AGE_KEY_FILE: keyFile }).status).toBe(0);
    const calls = readFileSync(join(root, "sops.jsonl"), "utf8").trim().split("\n");
    expect(
      calls.every((line) => (JSON.parse(line) as { env: Record<string, string> }).env.SOPS_AGE_KEY_FILE === keyFile),
    ).toBe(true);
  });

  it("fails extraction before invoking Wrangler", () => {
    writeFileSync(join(root, "values.json"), "{}");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Sops extraction failed");
    expect(existsSync(join(root, "upload.json"))).toBe(false);
    expectNamesOnly(result.stdout + result.stderr);
  });

  it("fails a nonzero Wrangler exit without echoing secret output", () => {
    writeFileSync(join(root, "upload.fail"), "");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Wrangler secret upload failed");
    expectNamesOnly(result.stdout + result.stderr);
  });

  it.each([["--unknown"], ["--vault"], ["--secret-file", "unused"]])("rejects malformed arguments %j", (...flags) => {
    const result = run(flags);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid arguments");
    expect(existsSync(join(root, "sops.jsonl"))).toBe(false);
  });
});
