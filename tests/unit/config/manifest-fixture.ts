export const validManifest = `
schemaVersion: 1
profiles:
  - id: verify-full
    consumer: ariadne
    mode: auto
    fallback: local
    remote: { label: pop-os, target: admin@pop-os, hostKeySha256: "SHA256:trusted" }
    workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }
    probes: { attempts: 2, connectTimeoutSeconds: 4, minimumFreeBytes: 10737418240 }
    sync: { provider: mutagen, mode: one-way-replica, ignores: [node_modules, .git] }
    bootstrap: { node: local-exact, packageManager: package.json, setup: ["./scripts/ds-bootstrap.sh"], fingerprint: [package.json, pnpm-lock.yaml] }
    workload: { command: ["./scripts/verify", "--full"], childEnvironment: { REMOTE_RUNNER_CHILD: "1" } }
    secrets: { allow: [NEON_DEV_DATABASE_URL], provider: ["node", "scripts/remote-runner-env.mjs"] }
    notifications: { policy: outage-recovery }
    benchmark: { samples: 3, workloads: [{ id: full, command: ["./scripts/verify", "--full"] }] }
`;
