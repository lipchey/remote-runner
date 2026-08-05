import { diagnosableMessage } from "../runtime/diagnostic.js";

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
      readonly detail?: string;
    };

const MAX_DETAIL_CHARS = 200;

/* `reason` is a closed enum consumed by notifications, so the operator never sees WHICH sync rule
   failed. The detail carries that one line — and only for a failure raised as diagnosable, never
   for text a remote, a provider or a native error contributed. */
function preparationDetail(caught: unknown): string | undefined {
  /* A PreparationError's own message only restates the reason; its cause carries what actually
     failed, and there is nothing to add when it has none. */
  const message = diagnosableMessage(caught instanceof PreparationError ? caught.cause : caught);
  if (message === undefined) return undefined;
  const [first = ""] = message.split("\n");
  const sanitized = first.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length > MAX_DETAIL_CHARS ? `${sanitized.slice(0, MAX_DETAIL_CHARS - 3)}...` : sanitized;
}

function reasonFor(step: (typeof PREPARATION_STEPS)[number]): PreparationReason {
  if (step === "validate") return "validation";
  if (step === "lock") return "lock";
  if (step === "probe") return "transport";
  if (step === "sync-pause" || step === "sync-resume-flush") return "sync";
  if (step === "git-workspace") return "workspace";
  if (step === "bootstrap") return "bootstrap";
  return "secrets";
}

/* Only a SUCCESSFUL release is memoized. Caching a rejected one made a transient release failure
   permanent, and the lock it left published is never reclaimed when the owner is a long-lived
   process such as the prewarm controller. */
function idempotentRelease(release: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= release().catch((caught: unknown) => {
      pending = undefined;
      throw caught;
    }));
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
      try {
        await release();
      } catch {
        return { ok: false, reason: "lock", retryable: false };
      }
    }
    const detail = preparationDetail(caught);
    return {
      ok: false,
      reason: caught instanceof PreparationError ? caught.reason : reasonFor(step),
      retryable: caught instanceof PreparationError ? caught.retryable : caught instanceof RetryablePreparationError,
      ...(detail === undefined ? {} : { detail }),
    };
  }
}
