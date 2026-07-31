export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const HELP = [
  "remote-runner run <profile> -- <command...>",
  "remote-runner validate [profile] [--manifest <path>]",
  "remote-runner status [profile]",
  "remote-runner doctor [profile]",
  "remote-runner logs [profile]",
  "remote-runner repair <profile> --dry-run|--apply",
  "remote-runner benchmark <profile>",
].join("\n");

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help") {
    io.stdout(HELP);
    return 0;
  }

  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
}
