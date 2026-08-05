export interface ControllerStatus {
  readonly loaded: boolean;
  readonly running: boolean;
  readonly compatible: boolean;
}

export interface ControllerRuntime {
  inspect(): Promise<ControllerStatus>;
  bootstrap(): Promise<void>;
  bootout(): Promise<void>;
  kickstart(): Promise<void>;
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
