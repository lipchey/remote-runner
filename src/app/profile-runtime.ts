import { stableReason } from "../notifications/outage.js";
import type { RunTelemetry } from "../runtime/telemetry.js";
import { prepareRemote, type PreparationRuntime } from "../run/prepare.js";
import { WORKLOAD_COMMAND_REASON, type RemoteExecutionResult, type RunProfileRuntime } from "../run/run-profile.js";

export interface ProfileExecutionServices extends PreparationRuntime {
  startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ): Promise<RemoteExecutionResult>;
  runLocal(command: readonly string[], prepared?: Readonly<Record<string, string>>): Promise<number>;
  recordFallback(reason: string): Promise<void>;
  recordOutage(reason: string): Promise<void>;
  recordRemoteChildStarted(): Promise<void>;
  reportUnavailable(reason: string, detail?: string): void;
}

/* The stderr write and the runner-log callback behind reportUnavailable can both fail (a closed
   pipe, an unwritable log), and this runs between storing the pending reason and returning the
   preparation result: an escaping throw would make runProfile read a diagnosed failure as an
   undiagnosed one, losing both the retry and the alert the report was announcing. */
function report(services: ProfileExecutionServices, reason: string, detail?: string): void {
  try {
    services.reportUnavailable(reason, detail);
  } catch {
    /* reporting never decides the run */
  }
}

/* Times each step here, not inside the service bodies, so a step retried by the prepare loop just
   adds to its own span. */
function timedPreparation(services: ProfileExecutionServices, telemetry: RunTelemetry): PreparationRuntime {
  return {
    validate: () => telemetry.measure("validate", () => services.validate()),
    acquireLock: () => telemetry.measure("lock", () => services.acquireLock()),
    probe: () => telemetry.measure("probe", () => services.probe()),
    pauseSync: () => telemetry.measure("sync-pause", () => services.pauseSync()),
    reconcileWorkspace: () => telemetry.measure("git-workspace", () => services.reconcileWorkspace()),
    resumeAndFlush: () => telemetry.measure("sync-resume", () => services.resumeAndFlush()),
    bootstrap: () => telemetry.measure("bootstrap", () => services.bootstrap()),
    collectSecrets: () => telemetry.measure("secrets", () => services.collectSecrets()),
  };
}

export function createProfileRuntime(services: ProfileExecutionServices, telemetry?: RunTelemetry): RunProfileRuntime {
  let pendingFallbackReason: string | undefined;
  let reportedReason: string | undefined;
  let reportedDetail: string | undefined;
  const preparation = telemetry === undefined ? services : timedPreparation(services, telemetry);
  return {
    async prepareRemote() {
      const result = await prepareRemote(preparation);
      if (result.ok) {
        pendingFallbackReason = undefined;
        reportedReason = undefined;
        reportedDetail = undefined;
      } else {
        const reason = stableReason(result.reason);
        pendingFallbackReason = reason;
        /* The prepare loop retries a retryable failure, and one run reporting the same failure twice
           reads as two outages to the operator and to the run log. Only a byte-identical repeat is
           suppressed: the detail is what makes a wedged sync diagnosable, so the same reason
           carrying a NEW detail ("daemon is not running" after "session is in conflict") is the
           actionable line and still reports. */
        if (reason !== reportedReason || result.detail !== reportedDetail) {
          reportedReason = reason;
          reportedDetail = result.detail;
          /* The notification channel keeps the stable reason; the detail reaches only the operator's
             stderr and the runner log. */
          report(services, reason, result.detail);
        }
      }
      return result;
    },
    async startRemote(command, secrets, onChildStarted) {
      let started = false;
      let result: RemoteExecutionResult;
      try {
        result = await services.startRemote(command, secrets, async () => {
          /* First statement, mirroring run-profile's own `childStarted`: everything from here on
             must be read as "the workload is running remotely", including a throw. */
          started = true;
          await onChildStarted();
          pendingFallbackReason = undefined;
          try {
            await services.recordRemoteChildStarted();
          } catch {
            /* notification never blocks workload */
          }
        });
      } catch (caught) {
        if (started) {
          /* The workload is already running remotely, so its result is unknown and a local rerun
             would repeat side effects — no fallback, and runProfile keeps exit 75. Not
             `connection-lost` though: what reaches here is a stream writer that threw and killed
             the local ssh process, which says nothing about the remote being down, so the operator
             gets the line and the log record without an outage alert. */
          report(services, "unknown");
          throw caught;
        }
        /* The controller threw before any child started — an internal invariant (remote paths or a
           toolchain root missing before their step ran), an invalid remote argument, a synchronous
           spawn failure. Identical outcome to the not-started result the same call returns without
           throwing, so it takes the same path instead of reaching runProfile's catch, which exits
           75 having established no reason at all. One reason for all of them: unlike the returning
           half, a throw carries no reason of its own, and inventing one per throw site would be a
           guess. Known ceiling: the marker arrives on the remote child's spawn event, so a throw in
           the window between that spawn and the marker reaching us falls back locally against a
           workload that is already alive — the same window the shipped non-throwing `!markerSeen`
           path already falls back through. */
        result = { kind: "not-started", reason: "child-start" };
      }
      if (result.kind === "not-started" && result.reason !== WORKLOAD_COMMAND_REASON) {
        /* The reason belongs to the site that knows what failed; only the closed-set mapping is
           applied here, so a secrets frame that could not be encoded stays `secrets`. */
        const reason = stableReason(result.reason);
        pendingFallbackReason = reason;
        report(services, reason);
      }
      return result;
    },
    async runLocal(command, prepared) {
      const reason = pendingFallbackReason;
      pendingFallbackReason = undefined;
      if (reason !== undefined) {
        try {
          await services.recordFallback(reason);
        } catch {
          /* notification never blocks fallback */
        }
      }
      return services.runLocal(command, prepared);
    },
    /* The outage is announced here rather than from prepareRemote so that a retryable failure the
       second attempt survives stays silent: the run reached the remote, so nothing was down for the
       operator to hear about. This is the same consumption point as runLocal, for the profile that
       has no local run to consume it. */
    async failClosed() {
      const reason = pendingFallbackReason;
      pendingFallbackReason = undefined;
      if (reason !== undefined) await services.recordOutage(reason);
    },
  };
}
