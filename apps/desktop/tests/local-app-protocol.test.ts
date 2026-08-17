import { describe, expect, it, vi } from "vitest";
import type { Protocol } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVillageProtocolInstalled } from "../src/main/local-app-protocol.js";

describe("Village app protocol installation", () => {
  it("installs the handler only once for the same protocol and renderer root", async () => {
    const rendererRoot = await mkdtemp(join(tmpdir(), "village-renderer-"));
    await writeFile(join(rendererRoot, "index.js"), "export {};");
    const protocol = {
      handle: vi.fn(),
    } as unknown as Protocol;

    try {
      ensureVillageProtocolInstalled(protocol, rendererRoot);
      ensureVillageProtocolInstalled(protocol, rendererRoot);

      expect(protocol.handle).toHaveBeenCalledTimes(1);
      expect(protocol.handle).toHaveBeenCalledWith(
        "village",
        expect.any(Function),
      );
    } finally {
      await rm(rendererRoot, { recursive: true });
    }
  });

  it("rejects a different renderer root for an installed protocol", async () => {
    const firstRendererRoot = await mkdtemp(
      join(tmpdir(), "village-renderer-first-"),
    );
    const secondRendererRoot = await mkdtemp(
      join(tmpdir(), "village-renderer-second-"),
    );
    await Promise.all([
      writeFile(join(firstRendererRoot, "index.js"), "export {};"),
      writeFile(join(secondRendererRoot, "index.js"), "export {};"),
    ]);
    const protocol = {
      handle: vi.fn(),
    } as unknown as Protocol;

    try {
      ensureVillageProtocolInstalled(protocol, firstRendererRoot);

      expect(() =>
        ensureVillageProtocolInstalled(protocol, secondRendererRoot),
      ).toThrowError("VILLAGE_PROTOCOL_RENDERER_ROOT_MISMATCH");
      expect(protocol.handle).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([
        rm(firstRendererRoot, { recursive: true }),
        rm(secondRendererRoot, { recursive: true }),
      ]);
    }
  });
});
