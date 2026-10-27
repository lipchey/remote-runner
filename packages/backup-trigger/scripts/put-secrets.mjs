import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_VAULT, extract } from "../../runner-router/scripts/vault.mjs";

const secretKeys = {
  GITHUB_BACKUP_DISPATCH_TOKEN: "GITHUB_BACKUP_DISPATCH_TOKEN",
  TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
  TELEGRAM_CHAT_ID: "TELEGRAM_CHAT_ID",
};
const envKeys = {
  CLOUDFLARE_REMOTE_RUNNER_TOKEN: "CLOUDFLARE_API_TOKEN",
  CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
};
const secretNames = Object.values(secretKeys);
const envNames = ["PATH", "HOME", ...Object.values(envKeys)];

try {
  let vault = DEFAULT_VAULT;
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--vault" && args[i + 1] && !args[i + 1].startsWith("--")) {
      vault = args[++i];
    } else {
      throw new Error("Invalid arguments");
    }
  }
  if (dryRun) {
    console.log(`Secrets: ${secretNames.join(", ")}`);
    console.log(`Environment: ${envNames.join(", ")}`);
  } else {
    const secrets = Object.fromEntries(Object.entries(secretKeys).map(([key, name]) => [name, extract(key, vault)]));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const [key, name] of Object.entries(envKeys)) env[name] = extract(key, vault);
    const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      input: JSON.stringify(secrets),
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Wrangler secret upload failed");
    console.log(`Uploaded secrets: ${secretNames.join(", ")}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Secret upload failed");
  process.exitCode = 1;
}
