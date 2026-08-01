import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RepairAction {
  readonly id: string;
  readonly target: string;
  readonly destructive: boolean;
}

export interface RepairPlan {
  readonly profile: string;
  readonly identity: string;
  readonly planHash: string;
  readonly actions: readonly RepairAction[];
}

export interface RepairReceipt extends RepairPlan {
  readonly schemaVersion: 1;
  readonly createdAt: string;
}

export interface RepairRuntime {
  readonly identity: string;
  readonly identityRoot: string;
  inspect(profile: string): Promise<readonly RepairAction[]>;
  readDryRun(profile: string): Promise<RepairReceipt | undefined>;
  writeDryRun(receipt: RepairReceipt): Promise<void>;
  apply(action: RepairAction): Promise<void>;
  now(): string;
}

const SAFE_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function closedAction(action: RepairAction): boolean {
  const keys = Object.keys(action).sort();
  return keys.length === 3 && keys[0] === "destructive" && keys[1] === "id" && keys[2] === "target";
}

function validatedActions(runtime: RepairRuntime, actions: readonly RepairAction[]): readonly RepairAction[] {
  if (!SAFE_IDENTITY.test(runtime.identity)) throw new Error("repair identity is invalid");
  if (!isAbsolute(runtime.identityRoot) || resolve(runtime.identityRoot) !== runtime.identityRoot) {
    throw new Error("repair identity root must be an absolute normalized path");
  }
  const rootSegments = runtime.identityRoot.split(sep).filter(Boolean);
  if (rootSegments.at(-1) !== runtime.identity) throw new Error("repair root does not match identity");
  if (actions.length > 64) throw new Error("repair plan has too many actions");
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const action of actions) {
    if (!closedAction(action) || !SAFE_ID.test(action.id) || typeof action.destructive !== "boolean") {
      throw new Error("repair action is invalid");
    }
    if (!isAbsolute(action.target) || resolve(action.target) !== action.target) {
      throw new Error("repair target must be an absolute normalized path");
    }
    const pathFromRoot = relative(runtime.identityRoot, action.target);
    if (
      pathFromRoot === "" ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error("repair target escapes identity root");
    }
    if (ids.has(action.id) || targets.has(action.target)) throw new Error("repair actions must be unique");
    ids.add(action.id);
    targets.add(action.target);
  }
  return actions.map((action) => ({ ...action }));
}

function planHash(profile: string, identity: string, actions: readonly RepairAction[]): string {
  return createHash("sha256").update(JSON.stringify({ profile, identity, actions })).digest("hex");
}

function makePlan(runtime: RepairRuntime, profile: string, actions: readonly RepairAction[]): RepairPlan {
  return {
    profile,
    identity: runtime.identity,
    planHash: planHash(profile, runtime.identity, actions),
    actions,
  };
}

export async function repair(
  runtime: RepairRuntime,
  profile: string,
  options: { readonly apply: boolean },
): Promise<RepairPlan> {
  if (!SAFE_ID.test(profile)) throw new Error("repair profile is invalid");
  const actions = validatedActions(runtime, await runtime.inspect(profile));
  const plan = makePlan(runtime, profile, actions);
  if (!options.apply) {
    await runtime.writeDryRun({
      schemaVersion: 1,
      createdAt: runtime.now(),
      ...plan,
    });
    return plan;
  }

  const receipt = await runtime.readDryRun(profile);
  if (receipt === undefined) throw new Error("run repair --dry-run first");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profile !== profile ||
    receipt.identity !== runtime.identity ||
    receipt.planHash !== plan.planHash
  )
    throw new Error("repair plan changed; run repair --dry-run first");

  for (const action of plan.actions) await runtime.apply(action);
  return plan;
}
