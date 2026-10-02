import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/put-secrets.mjs");
const pem = "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n";
const values: Record<string, string> = {
  GITHUB_APP_RUNNER_ROUTER_ID: "fixture-app-id",
  GITHUB_APP_RUNNER_ROUTER_INSTALLATION_ID: "fixture-installation-id",
  GITHUB_APP_RUNNER_ROUTER_PRIVATE_KEY_B64: Buffer.from(pem).toString("base64"),
  TELEGRAM_BOT_TOKEN: "fixture-telegram-token",
  TELEGRAM_CHAT_ID: "fixture-chat-id",
  CLOUDFLARE_REMOTE_RUNNER_TOKEN: "fixture-cloudflare-token",
  CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID: "fixture-cloudflare-account",
};
const secretNames = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "HEARTBEAT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
].sort();
const envNames = ["PATH", "HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].sort();
let root: string;

function stub(name: string, source: string) {
  const path = join(root, "bin", name);
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
}

function run(flags: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--vault",
      join(root, "fixture.env.sops.yaml"),
      "--secret-file",
      join(root, "config/heartbeat-secret"),
      ...flags,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        UNRELATED_SECRET: "fixture-unrelated-secret",
        HOME: root,
        SOPS_AGE_KEY_FILE: undefined,
        ...env,
      },
    },
  );
}

function upload() {
  return JSON.parse(readFileSync(join(root, "upload.json"), "utf8")) as {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    secrets: Record<string, string>;
    local: { secret?: string; candidate?: string; mode?: number };
  };
}

function expectNamesOnly(output: string, uploaded: Record<string, string> = {}) {
  for (const value of [...Object.values(values), pem, ...Object.values(uploaded), "fixture-unrelated-secret"]) {
    expect(output).not.toContain(value);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-secrets-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "values.json"), JSON.stringify(values));
  stub(
    "sops",
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, "sops.jsonl"))}, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[args.indexOf('--input-type') + 1] !== 'dotenv') process.exit(1);
const key = JSON.parse(args[args.indexOf('--extract') + 1])[0];
const values = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "values.json"))}, 'utf8'));
if (!Object.hasOwn(values, key)) process.exit(1);
process.stdout.write(values[key]);
`,
  );
  stub(
    "pnpm",
    `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root, "pnpm.json"))}, JSON.stringify(args));
const result = spawnSync('wrangler', args.slice(2), { env: process.env, input: fs.readFileSync(0) });
process.exit(result.status ?? 1);
`,
  );
  stub(
    "wrangler",
    `const fs = require('node:fs');
const path = ${JSON.stringify(join(root, "config/heartbeat-secret"))};
const read = (path) => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
const local = { secret: read(path), candidate: read(path + '.new'), mode: fs.existsSync(path + '.new') ? fs.statSync(path + '.new').mode & 0o777 : undefined };
fs.writeFileSync(${JSON.stringify(join(root, "upload.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, secrets: JSON.parse(fs.readFileSync(0, 'utf8')), local }));
process.stdout.write('fixture-telegram-token');
if (fs.existsSync(${JSON.stringify(join(root, "rename.fail"))})) fs.mkdirSync(path);
process.exit(fs.existsSync(${JSON.stringify(join(root, "upload.fail"))}) ? 1 : 0);
`,
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("secret upload", () => {
  it("uploads exactly six allowlisted secrets with a decoded PEM and only four environment names", () => {
    const result = run();
    expect(result.status).toBe(0);
    const sent = upload();
    expect(sent.args).toEqual(["secret", "bulk"]);
    expect(sent.cwd).toBe(resolve("."));
    expect(JSON.parse(readFileSync(join(root, "pnpm.json"), "utf8"))).toEqual(["exec", "wrangler", "secret", "bulk"]);
    expect(Object.keys(sent.secrets).sort()).toEqual(secretNames);
    expect(sent.secrets).toMatchObject({
      GITHUB_APP_ID: values.GITHUB_APP_RUNNER_ROUTER_ID,
      GITHUB_APP_INSTALLATION_ID: values.GITHUB_APP_RUNNER_ROUTER_INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY: pem,
      TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: values.TELEGRAM_CHAT_ID,
    });
    expect(sent.secrets.HEARTBEAT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(sent.local).toEqual({ candidate: `${sent.secrets.HEARTBEAT_SECRET}\n`, mode: 0o600 });
    /* The macOS Node runtime adds this locale hint after receiving the explicit environment. */
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
    expect(calls).toHaveLength(7);
    expect(
      calls
        .map((call) => JSON.parse(call.args[call.args.indexOf("--extract") + 1] ?? "") as string[])
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
      expect(
        Object.keys(call.env)
          .filter((name) => process.platform !== "darwin" || name !== "__CF_USER_TEXT_ENCODING")
          .sort(),
      ).toEqual(["HOME", "PATH", "SOPS_AGE_KEY_FILE"]);
      expect(call.env.HOME).toBe(root);
      expect(call.env.SOPS_AGE_KEY_FILE).toBe(join(root, ".config/sops/age/keys.txt"));
    }
    const path = join(root, "config/heartbeat-secret");
    expect(readFileSync(path, "utf8").trim()).toBe(sent.secrets.HEARTBEAT_SECRET);
    expect(existsSync(`${path}.new`)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "config")).mode & 0o777).toBe(0o700);
    for (const name of secretNames) expect(result.stdout).toContain(name);
    expect(result.stdout).toContain(path);
    expectNamesOnly(result.stdout + result.stderr, sent.secrets);
  });

  it("dry-run prints names only without sops, wrangler, or filesystem writes", () => {
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    for (const name of [...secretNames, ...envNames]) expect(result.stdout).toContain(name);
    expectNamesOnly(result.stdout + result.stderr);
    expect(result.stdout).not.toContain(root);
    expect(existsSync(join(root, "sops.jsonl"))).toBe(false);
    expect(existsSync(join(root, "pnpm.json"))).toBe(false);
    expect(existsSync(join(root, "upload.json"))).toBe(false);
    expect(existsSync(join(root, "config"))).toBe(false);
  });
  it("honors an explicit age key file for every sops extraction", () => {
    const keyFile = join(root, "custom-age-keys.txt");
    expect(run([], { SOPS_AGE_KEY_FILE: keyFile }).status).toBe(0);
    const calls = readFileSync(join(root, "sops.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { env: Record<string, string> });
    expect(calls.every((call) => call.env.SOPS_AGE_KEY_FILE === keyFile)).toBe(true);
  });

  it("rejects a bad decoded PEM before any upload", () => {
    writeFileSync(
      join(root, "values.json"),
      JSON.stringify({
        ...values,
        GITHUB_APP_RUNNER_ROUTER_PRIVATE_KEY_B64: Buffer.from("bad-key").toString("base64"),
      }),
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Decoded private key must start with -----BEGIN");
    expect(existsSync(join(root, "pnpm.json"))).toBe(false);
    expect(existsSync(join(root, "config"))).toBe(false);
    expectNamesOnly(result.stdout + result.stderr);
  });

  it("fails a nonzero wrangler exit without writing a secret file", () => {
    writeFileSync(join(root, "upload.fail"), "");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Wrangler secret upload failed");
    expect(existsSync(join(root, "upload.json"))).toBe(true);
    expect(upload().local.candidate).toBe(`${upload().secrets.HEARTBEAT_SECRET}\n`);
    expect(existsSync(join(root, "config/heartbeat-secret"))).toBe(false);
    expect(existsSync(join(root, "config/heartbeat-secret.new"))).toBe(false);
    expectNamesOnly(result.stdout + result.stderr, upload().secrets);
  });

  it("fails sops extraction without uploading or writing a secret", () => {
    writeFileSync(join(root, "values.json"), "{}");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Sops extraction failed");
    expect(existsSync(join(root, "pnpm.json"))).toBe(false);
    expect(existsSync(join(root, "config"))).toBe(false);
    expectNamesOnly(result.stdout + result.stderr);
  });

  it("replaces an existing secret with mode 0600 without re-moding its directory", () => {
    mkdirSync(join(root, "config"), { mode: 0o755 });
    writeFileSync(join(root, "config/heartbeat-secret"), "old-secret", { mode: 0o644 });
    expect(run().status).toBe(0);
    expect(statSync(join(root, "config")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "config/heartbeat-secret")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "config/heartbeat-secret"), "utf8").trim()).toBe(upload().secrets.HEARTBEAT_SECRET);
    expect(upload().local.secret).toBe("old-secret");
    expect(upload().local.candidate).toBe(`${upload().secrets.HEARTBEAT_SECRET}\n`);
    expect(existsSync(join(root, "config/heartbeat-secret.new"))).toBe(false);
  });
  it("removes the candidate after upload failure and preserves an existing secret", () => {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/heartbeat-secret"), "old-secret");
    writeFileSync(join(root, "upload.fail"), "");
    expect(run().status).toBe(1);
    expect(upload().local.candidate).toBe(`${upload().secrets.HEARTBEAT_SECRET}\n`);
    expect(readFileSync(join(root, "config/heartbeat-secret"), "utf8")).toBe("old-secret");
    expect(existsSync(join(root, "config/heartbeat-secret.new"))).toBe(false);
  });
  it("fails local preparation before invoking wrangler", () => {
    writeFileSync(join(root, "config"), "occupied");
    expect(run().status).toBe(1);
    expect(existsSync(join(root, "pnpm.json"))).toBe(false);
    expect(existsSync(join(root, "upload.json"))).toBe(false);
  });
  it("retains the uploaded candidate if promotion fails", () => {
    writeFileSync(join(root, "rename.fail"), "");
    expect(run().status).toBe(1);
    expect(readFileSync(join(root, "config/heartbeat-secret.new"), "utf8")).toBe(
      `${upload().secrets.HEARTBEAT_SECRET}\n`,
    );
  });

  it.each([{ flags: ["--unknown"] }, { flags: ["--vault"] }, { flags: ["--secret-file"] }])(
    "rejects malformed arguments $flags before extracting",
    ({ flags }) => {
      const result = run(flags);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid arguments");
      expect(existsSync(join(root, "sops.jsonl"))).toBe(false);
    },
  );
});
