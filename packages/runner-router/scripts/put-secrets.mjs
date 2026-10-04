import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VAULT, extract } from "./vault.mjs";

const secretKeys = {
  GITHUB_APP_RUNNER_ROUTER_ID: "GITHUB_APP_ID",
  GITHUB_APP_RUNNER_ROUTER_INSTALLATION_ID: "GITHUB_APP_INSTALLATION_ID",
  GITHUB_APP_RUNNER_ROUTER_PRIVATE_KEY_B64: "GITHUB_APP_PRIVATE_KEY",
  TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
  TELEGRAM_CHAT_ID: "TELEGRAM_CHAT_ID",
};
const envKeys = {
  CLOUDFLARE_REMOTE_RUNNER_TOKEN: "CLOUDFLARE_API_TOKEN",
  CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
};
const secretNames = [...Object.values(secretKeys), "HEARTBEAT_SECRET"];
const envNames = ["PATH", "HOME", ...Object.values(envKeys)];

try {
  let vault = DEFAULT_VAULT;
  let secretFile = join(homedir(), ".config/runner-router/heartbeat-secret");
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if ((args[i] === "--vault" || args[i] === "--secret-file") && args[i + 1] && !args[i + 1].startsWith("--")) {
      if (args[i] === "--vault") vault = args[++i];
      else secretFile = args[++i];
    } else {
      throw new Error("Invalid arguments");
    }
  }
  if (dryRun) {
    console.log(`Secrets: ${secretNames.join(", ")}`);
    console.log(`Environment: ${envNames.join(", ")}`);
  } else {
    const secrets = Object.fromEntries(Object.entries(secretKeys).map(([key, name]) => [name, extract(key, vault)]));
    secrets.GITHUB_APP_PRIVATE_KEY = Buffer.from(secrets.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8");
    if (!secrets.GITHUB_APP_PRIVATE_KEY.startsWith("-----BEGIN")) {
      throw new Error("Decoded private key must start with -----BEGIN");
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const [key, name] of Object.entries(envKeys)) env[name] = extract(key, vault);
    secrets.HEARTBEAT_SECRET = randomBytes(32).toString("hex");
    mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
    const candidate = `${secretFile}.new`;
    try {
      const fd = openSync(candidate, "w", 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, `${secrets.HEARTBEAT_SECRET}\n`);
      } finally {
        closeSync(fd);
      }
      const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env,
        input: JSON.stringify(secrets),
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error("Wrangler secret upload failed");
    } catch (error) {
      rmSync(candidate, { force: true });
      throw error;
    }
    renameSync(candidate, secretFile);
    console.log(`Uploaded secrets: ${secretNames.join(", ")}`);
    console.log(`Heartbeat secret file: ${secretFile}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Secret upload failed");
  process.exitCode = 1;
}
