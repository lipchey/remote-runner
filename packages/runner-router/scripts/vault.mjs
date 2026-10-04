import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_VAULT = "/Users/admin/Projects/ariadne/.env.sops.yaml";

export function extract(key, vault = DEFAULT_VAULT) {
  const result = spawnSync("sops", ["-d", "--input-type", "dotenv", "--extract", JSON.stringify([key]), vault], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SOPS_AGE_KEY_FILE: process.env.SOPS_AGE_KEY_FILE ?? join(homedir(), ".config/sops/age/keys.txt"),
    },
  });
  if (result.status !== 0 || !result.stdout) throw new Error(`Sops extraction failed: ${key}`);
  return result.stdout;
}
