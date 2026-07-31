export type RunMode = "auto" | "local" | "remote";

export interface Profile {
  id: string;
  consumer: string;
  mode: RunMode;
  fallback: "local" | "fail";
  remote: {
    label: string;
    target: string;
    hostKeySha256: string;
  };
  workspace: {
    generatedRoot: "~/.cache/remote-runner/workspaces";
    baseRef?: string;
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
    fingerprint: string[];
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
