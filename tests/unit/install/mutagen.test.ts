import { describe, expect, it } from "vitest";

import { mutagenDarwinArchitecture } from "../../../src/install/mutagen.js";

describe("Mutagen installer", () => {
  it.each([
    ["x86_64", "amd64"],
    ["arm64", "arm64"],
  ])("maps %s to %s", (machine, arch) => {
    expect(mutagenDarwinArchitecture(machine)).toBe(arch);
  });
});
