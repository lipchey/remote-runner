export const PREPARATION_STEPS = [
  "validate",
  "lock",
  "probe",
  "sync-pause",
  "git-workspace",
  "sync-resume-flush",
  "bootstrap",
  "secrets",
  "child-start",
] as const;

export type PreparationReason =
  | "validation"
  | "lock"
  | "transport"
  | "dns"
  | "host-key"
  | "authentication"
  | "remote-shell"
  | "capacity"
  | "sync"
  | "workspace"
  | "bootstrap"
  | "secrets";

export class RetryablePreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryablePreparationError";
  }
}

export class PreparationError extends Error {
  constructor(
    readonly reason: PreparationReason,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(`remote preparation failed: ${reason}`, options);
    this.name = "PreparationError";
  }
}

export interface PreparationRuntime {
  validate(): Promise<void>;
  acquireLock(): Promise<() => Promise<void>>;
  probe(): Promise<void>;
  pauseSync(): Promise<void>;
  reconcileWorkspace(): Promise<void>;
  resumeAndFlush(): Promise<void>;
  bootstrap(): Promise<void>;
  collectSecrets(): Promise<Readonly<Record<string, string>>>;
}

export type PrepareResult =
  | {
      readonly ok: true;
      readonly secrets: Readonly<Record<string, string>>;
      release(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly reason: PreparationReason | string;
      readonly retryable: boolean;
    };

function reasonFor(step: (typeof PREPARATION_STEPS)[number]): PreparationReason {
  if (step === "validate") return "validation";
  if (step === "lock") return "lock";
  if (step === "probe") return "transport";
  if (step === "sync-pause" || step === "sync-resume-flush") return "sync";
  if (step === "git-workspace") return "workspace";
  if (step === "bootstrap") return "bootstrap";
  return "secrets";
}

function idempotentRelease(release: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= release();
}

export async function prepareRemote(runtime: PreparationRuntime): Promise<PrepareResult> {
  let step: (typeof PREPARATION_STEPS)[number] = "validate";
  let release: (() => Promise<void>) | undefined;
  try {
    await runtime.validate();
    step = "lock";
    release = idempotentRelease(await runtime.acquireLock());
    step = "probe";
    await runtime.probe();
    step = "sync-pause";
    await runtime.pauseSync();
    step = "git-workspace";
    await runtime.reconcileWorkspace();
    step = "sync-resume-flush";
    await runtime.resumeAndFlush();
    step = "bootstrap";
    await runtime.bootstrap();
    step = "secrets";
    const secrets = await runtime.collectSecrets();
    return { ok: true, secrets, release };
  } catch (caught) {
    if (release !== undefined) {
      try { await release(); } catch { return { ok: false, reason: "lock", retryable: false }; }
    }
    return {
      ok: false,
      reason: caught instanceof PreparationError ? caught.reason : reasonFor(step),
      retryable: caught instanceof PreparationError
        ? caught.retryable
        : caught instanceof RetryablePreparationError,
    };
  }
}
