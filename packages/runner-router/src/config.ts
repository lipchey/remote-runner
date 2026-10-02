export interface Env {
  ROUTER: DurableObjectNamespace;
  REPO: string;
  PC_RUNNERS: string;
  LAPTOP_RUNNER: string;
  LAPTOP_ADMISSION_LABELS: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  HEARTBEAT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export interface Config {
  readonly repo: string;
  readonly pcRunners: readonly string[];
  readonly laptopRunner: string;
  readonly laptopAdmissionLabels: readonly ("ci-active" | "popos")[];
  readonly githubAppId: string;
  readonly githubAppInstallationId: string;
  readonly githubAppPrivateKey: string;
  readonly heartbeatSecret: string;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
}

export function parseConfig(env: Partial<Env>): Config {
  function required(key: keyof Omit<Env, "ROUTER">): string {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Invalid ${key}: value is required`);
    }
    return value;
  }

  function csv(key: "PC_RUNNERS" | "LAPTOP_ADMISSION_LABELS"): string[] {
    const values = required(key)
      .split(",")
      .map((value) => value.trim());
    if (values.some((value) => value === "") || new Set(values).size !== values.length) {
      throw new Error(`Invalid ${key}: entries must be nonempty and unique`);
    }
    return values;
  }

  const pcRunners = csv("PC_RUNNERS");
  const laptopRunner = required("LAPTOP_RUNNER").trim();
  if (pcRunners.includes(laptopRunner)) {
    throw new Error("Invalid LAPTOP_RUNNER: must not be a PC runner");
  }
  const laptopAdmissionLabels = csv("LAPTOP_ADMISSION_LABELS").map((label) => {
    if (label !== "ci-active" && label !== "popos") {
      throw new Error("Invalid LAPTOP_ADMISSION_LABELS: allowed labels are ci-active and popos");
    }
    return label;
  });

  return {
    repo: required("REPO").trim(),
    pcRunners,
    laptopRunner,
    laptopAdmissionLabels,
    githubAppId: required("GITHUB_APP_ID"),
    githubAppInstallationId: required("GITHUB_APP_INSTALLATION_ID"),
    githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY"),
    heartbeatSecret: required("HEARTBEAT_SECRET"),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
  };
}
