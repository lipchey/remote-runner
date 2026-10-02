import { describe, expect, it } from "vitest";

import { parseConfig, type Env } from "../src/config.js";

const validEnv = {
  REPO: "lipchey/ariadne",
  PC_RUNNERS: "popos-1,popos-2,popos-3",
  LAPTOP_RUNNER: "ariadne-runner-1",
  LAPTOP_ADMISSION_LABELS: "ci-active",
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
  HEARTBEAT_SECRET: "heartbeat-secret",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHAT_ID: "-123",
} satisfies Partial<Env>;

const fields = Object.keys(validEnv) as (keyof typeof validEnv)[];

describe("Worker configuration", () => {
  it("parses every variable and secret", () => {
    expect(parseConfig(validEnv)).toEqual({
      repo: "lipchey/ariadne",
      pcRunners: ["popos-1", "popos-2", "popos-3"],
      laptopRunner: "ariadne-runner-1",
      laptopAdmissionLabels: ["ci-active"],
      githubAppId: "123",
      githubAppInstallationId: "456",
      githubAppPrivateKey: validEnv.GITHUB_APP_PRIVATE_KEY,
      heartbeatSecret: "heartbeat-secret",
      telegramBotToken: "bot-token",
      telegramChatId: "-123",
    });
  });

  it("trims variables and accepts both allowlisted labels", () => {
    const config = parseConfig({
      ...validEnv,
      REPO: " lipchey/ariadne ",
      PC_RUNNERS: " popos-1 , popos-2 , popos-3 ",
      LAPTOP_RUNNER: " ariadne-runner-1 ",
      LAPTOP_ADMISSION_LABELS: " ci-active , popos ",
    });
    expect(config.repo).toBe("lipchey/ariadne");
    expect(config.pcRunners).toEqual(["popos-1", "popos-2", "popos-3"]);
    expect(config.laptopRunner).toBe("ariadne-runner-1");
    expect(config.laptopAdmissionLabels).toEqual(["ci-active", "popos"]);
  });

  it("preserves secret bytes", () => {
    const config = parseConfig({ ...validEnv, HEARTBEAT_SECRET: " secret " });
    expect(config.heartbeatSecret).toBe(" secret ");
    expect(config.githubAppPrivateKey).toBe(validEnv.GITHUB_APP_PRIVATE_KEY);
  });

  it.each(fields)("rejects missing %s", (field) => {
    const env: Partial<Env> = { ...validEnv };
    delete env[field];
    expect(() => parseConfig(env)).toThrow(field);
  });

  it.each(fields)("rejects empty %s", (field) => {
    expect(() => parseConfig({ ...validEnv, [field]: "" })).toThrow(field);
  });

  it.each(fields)("rejects whitespace-only %s", (field) => {
    expect(() => parseConfig({ ...validEnv, [field]: " \n\t " })).toThrow(field);
  });

  it.each(["popos-1,", ",popos-1", "popos-1,,popos-2", "popos-1, ,popos-2"])(
    "rejects empty PC runner names in %s",
    (pcRunners) => {
      expect(() => parseConfig({ ...validEnv, PC_RUNNERS: pcRunners })).toThrow("PC_RUNNERS");
    },
  );

  it("rejects duplicate PC runner names after trimming", () => {
    expect(() => parseConfig({ ...validEnv, PC_RUNNERS: "popos-1, popos-1 " })).toThrow("PC_RUNNERS");
  });

  it("rejects the laptop name in PC_RUNNERS after trimming", () => {
    expect(() => parseConfig({ ...validEnv, LAPTOP_RUNNER: " popos-2 " })).toThrow("LAPTOP_RUNNER");
  });

  it.each(["pc-runner", "CI-ACTIVE", "ci-active,unsafe", "popos,unsafe"])(
    "rejects a label outside the allowlist in %s",
    (labels) => {
      expect(() => parseConfig({ ...validEnv, LAPTOP_ADMISSION_LABELS: labels })).toThrow("LAPTOP_ADMISSION_LABELS");
    },
  );

  it.each(["ci-active,ci-active", "popos, popos "])("rejects duplicate labels in %s", (labels) => {
    expect(() => parseConfig({ ...validEnv, LAPTOP_ADMISSION_LABELS: labels })).toThrow("LAPTOP_ADMISSION_LABELS");
  });

  it.each(["ci-active,", ",popos", "ci-active,,popos", "ci-active, ,popos"])(
    "rejects empty label entries in %s",
    (labels) => {
      expect(() => parseConfig({ ...validEnv, LAPTOP_ADMISSION_LABELS: labels })).toThrow("LAPTOP_ADMISSION_LABELS");
    },
  );
});
