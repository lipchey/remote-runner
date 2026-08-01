export interface ControllerStatus {
  readonly loaded: boolean;
  readonly running: boolean;
  readonly compatible: boolean;
}

export interface ControllerHealth {
  readonly healthy: boolean;
  readonly reason?: string;
}

export interface ControllerRuntime {
  inspect(): Promise<ControllerStatus>;
  bootstrap(): Promise<void>;
  bootout(): Promise<void>;
  kickstart(): Promise<void>;
  registeredProfiles(): Promise<readonly string[]>;
  reconcile(profile: string): Promise<ControllerHealth>;
  recordHealth(profile: string, health: ControllerHealth): Promise<void>;
}

export async function ensureController(runtime: ControllerRuntime): Promise<void> {
  const status = await runtime.inspect();
  if (status.loaded && status.running && status.compatible) return;
  if (!status.compatible && status.loaded) {
    await runtime.bootout();
    await runtime.bootstrap();
  } else if (!status.loaded) {
    await runtime.bootstrap();
  } else {
    await runtime.kickstart();
  }
  const repaired = await runtime.inspect();
  if (!repaired.loaded || !repaired.running || !repaired.compatible) {
    throw new Error("remote-runner controller remains unhealthy after repair");
  }
}

export async function runControllerPass(runtime: ControllerRuntime): Promise<void> {
  const profiles = [...(await runtime.registeredProfiles())];
  if (
    profiles.length > 1_024 ||
    new Set(profiles).size !== profiles.length ||
    profiles.some((profile) => !/^[a-z][a-z0-9-]{0,62}$/u.test(profile))
  ) {
    throw new Error("registered controller profiles are invalid");
  }
  for (const profile of profiles) {
    let health: ControllerHealth;
    try {
      health = await runtime.reconcile(profile);
    } catch {
      health = { healthy: false, reason: "controller" };
    }
    if (
      typeof health.healthy !== "boolean" ||
      (health.reason !== undefined && !/^[a-z][a-z0-9-]{0,62}$/u.test(health.reason))
    ) {
      health = { healthy: false, reason: "controller" };
    }
    await runtime.recordHealth(profile, health);
  }
}
