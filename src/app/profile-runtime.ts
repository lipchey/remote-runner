import { isNotificationReason } from "../notifications/outage.js";
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
  recordRemoteChildStarted(): Promise<void>;
  reportUnavailable(reason: string, detail?: string): void;
}

function stableReason(reason: string): string {
  return isNotificationReason(reason) ? reason : "unknown";
}

export function createProfileRuntime(services: ProfileExecutionServices): RunProfileRuntime {
  let pendingFallbackReason: string | undefined;
  return {
    async prepareRemote() {
      const result = await prepareRemote(services);
      if (result.ok) pendingFallbackReason = undefined;
      else {
        const reason = stableReason(result.reason);
        pendingFallbackReason = reason;
        /* The notification channel keeps the stable reason; the detail reaches only the operator's
           stderr and the runner log, which is what makes a wedged sync diagnosable. */
        services.reportUnavailable(reason, result.detail);
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
        services.reportUnavailable("child-start");
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
  };
}
