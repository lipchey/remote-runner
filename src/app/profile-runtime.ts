import { stableReason } from "../notifications/outage.js";
import { prepareRemote, type PreparationRuntime } from "../run/prepare.js";
import { WORKLOAD_COMMAND_REASON, type RemoteExecutionResult, type RunProfileRuntime } from "../run/run-profile.js";

export interface ProfileExecutionServices extends PreparationRuntime {
  startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ): Promise<RemoteExecutionResult>;
  runLocal(command: readonly string[]): Promise<number>;
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

export function createProfileRuntime(services: ProfileExecutionServices): RunProfileRuntime {
  let pendingFallbackReason: string | undefined;
  let reportedReason: string | undefined;
  let reportedDetail: string | undefined;
  return {
    async prepareRemote() {
      const result = await prepareRemote(services);
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
      const result = await services.startRemote(command, secrets, async () => {
        await onChildStarted();
        pendingFallbackReason = undefined;
        try {
          await services.recordRemoteChildStarted();
        } catch {
          /* notification never blocks workload */
        }
      });
      if (result.kind === "not-started" && result.reason !== WORKLOAD_COMMAND_REASON) {
        pendingFallbackReason = "child-start";
        report(services, "child-start");
      }
      return result;
    },
    async runLocal(command) {
      const reason = pendingFallbackReason;
      pendingFallbackReason = undefined;
      if (reason !== undefined) {
        try {
          await services.recordFallback(reason);
        } catch {
          /* notification never blocks fallback */
        }
      }
      return services.runLocal(command);
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
