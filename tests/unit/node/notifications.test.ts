import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeTelegramRuntime } from "../../../src/node/notifications.js";

describe("NodeTelegramRuntime", () => {
  it("reads contents and metadata from one secure regular-file descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-telegram-"));
    const path = join(root, "telegram.conf");
    await writeFile(path, "BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nCHAT_ID=123\n");
    await chmod(path, 0o600);

    const file = await new NodeTelegramRuntime().readConfigFile(path);

    expect(file.kind).toBe("file");
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.size).toBe(file.contents.byteLength);
  });

  it("refuses to follow a symlink to the Telegram config", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-telegram-link-"));
    const target = join(root, "target.conf");
    const link = join(root, "telegram.conf");
    await writeFile(target, "BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nCHAT_ID=123\n");
    await symlink(target, link);

    await expect(new NodeTelegramRuntime().readConfigFile(link)).rejects.toThrow();
  });
});
