export interface FileInfo {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
}

export interface FileSystemPort {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array, mode: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileInfo>;
}

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

export interface ClockPort {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HashingPort {
  sha256(contents: Uint8Array): Promise<string>;
}

export interface RuntimePorts {
  readonly files: FileSystemPort;
  readonly processes: ProcessPort;
  readonly clock: ClockPort;
  readonly http: HttpPort;
  readonly hashing: HashingPort;
}
