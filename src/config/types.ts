export type RunMode = "auto" | "local" | "remote";

export interface WorkspaceRetentionPolicy {
  keep: number;
  graceMinutes: number;
}

export interface Profile {
  id: string;
  consumer: string;
  mode: RunMode;
  fallback: "local" | "fail" | string;
  remote: {
    label: string;
    target: string;
    hostKeySha256: string;
  };
  workspace: {
    generatedRoot: string;
    baseRef?: string;
    retention?: WorkspaceRetentionPolicy;
  };
  probes: {
    attempts: 2;
    connectTimeoutSeconds: number;
    minimumFreeBytes: number;
  };
  sync: {
    provider: "mutagen";
    mode: "one-way-replica";
    ignores: string[];
  };
  bootstrap: {
    node: "local-exact";
    packageManager: string;
    setup: string[];
    artifacts: string[];
    ensure: string[][];
    fingerprint: {
      files: string[];
      patterns: string[];
    };
  };
  workload: {
    command: string[];
    childEnvironment: Record<string, string>;
  };
  secrets: {
    allow: string[];
    provider?: string[];
    dotenv?: string;
  };
  notifications: {
    policy: "outage-recovery";
  };
  benchmark: {
    samples: number;
    workloads: Array<{
      id: string;
      command: string[];
    }>;
  };
}

export interface ManifestV1 {
  schemaVersion: 1;
  profiles: Profile[];
}
