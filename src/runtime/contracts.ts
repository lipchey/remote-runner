export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ProcessPort {
  run(request: ProcessRequest): Promise<ProcessResult>;
  isAlive(pid: number): Promise<boolean>;
}
