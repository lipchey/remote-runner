export function mutagenDarwinArchitecture(machine: string): "amd64" | "arm64" {
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "arm64" || machine === "aarch64") return "arm64";
  throw new Error(`unsupported Darwin architecture: ${JSON.stringify(machine)}`);
}
