import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVillageSbomInventory,
  createCycloneDxBom,
  requireExactElectronVersion,
  validateCycloneDxBom,
  validateOfficialCycloneDxBom,
} from "./generate-sbom.mjs";

const inventory = {
  root: {
    name: "village",
    version: "1.0.0",
    license: "MIT",
    kind: "application",
    dependencies: ["@village/desktop@1.0.0"],
  },
  components: [
    {
      name: "@village/desktop",
      version: "1.0.0",
      license: "MIT",
      kind: "application",
      dependencies: ["electron@43.2.0", "react@19.2.8"],
    },
    {
      name: "electron",
      version: "43.2.0",
      license: "MIT",
      kind: "framework",
      dependencies: [],
      resolved: "https://registry.npmjs.org/electron/-/electron-43.2.0.tgz",
    },
    {
      name: "react",
      version: "19.2.8",
      license: "MIT",
      kind: "library",
      dependencies: [],
    },
  ],
};

test("creates a deterministic path-free CycloneDX release inventory", () => {
  const first = createCycloneDxBom(inventory);
  const second = createCycloneDxBom({
    ...inventory,
    components: [...inventory.components].reverse(),
  });

  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.specVersion, "1.6");
  assert.deepEqual(
    first.components.map((component) => component.name),
    ["@village/desktop", "electron", "react"],
  );
  assert.deepEqual(
    first.dependencies.find(
      (dependency) => dependency.ref === "pkg:npm/village@1.0.0",
    ),
    {
      ref: "pkg:npm/village@1.0.0",
      dependsOn: ["pkg:npm/%40village/desktop@1.0.0"],
    },
  );
  assert.doesNotMatch(JSON.stringify(first), /private\/tmp|node_modules/);
  assert.doesNotThrow(() => validateCycloneDxBom(first));
});

test("rejects incomplete, duplicate, or dangling inventory", () => {
  assert.throws(
    () =>
      createCycloneDxBom({
        ...inventory,
        components: [
          ...inventory.components,
          { ...inventory.components[0], license: "Apache-2.0" },
        ],
      }),
    /SBOM_COMPONENT_CONFLICT/,
  );
  assert.throws(
    () =>
      createCycloneDxBom({
        ...inventory,
        components: [
          {
            ...inventory.components[0],
            dependencies: ["missing@1.0.0"],
          },
        ],
      }),
    /SBOM_DEPENDENCY_MISSING/,
  );
});

test("rejects unsafe distribution URLs before they enter the SBOM", () => {
  assert.throws(
    () =>
      createCycloneDxBom({
        ...inventory,
        components: inventory.components.map((component) =>
          component.name === "electron"
            ? {
                ...component,
                resolved:
                  "https://registry.npmjs.org/electron.tgz?token=secret",
              }
            : component,
        ),
      }),
    /SBOM_DISTRIBUTION_URL_UNSAFE/,
  );
});

test("passes the official strict CycloneDX 1.6 JSON schema", async () => {
  await assert.doesNotReject(
    validateOfficialCycloneDxBom(createCycloneDxBom(inventory)),
  );
});

test("requires the installed Electron runtime to match the builder pin", () => {
  assert.equal(requireExactElectronVersion("43.2.0", "43.2.0"), "43.2.0");
  assert.throws(
    () => requireExactElectronVersion("43.9.0", "43.2.0"),
    /SBOM_ELECTRON_VERSION_DRIFT/,
  );
});

test("inventories the installed release graph and bundled Electron runtime", async () => {
  const bom = createCycloneDxBom(await collectVillageSbomInventory());
  assert.equal(bom.metadata.component.name, "@village/desktop");
  const names = new Set(bom.components.map((component) => component.name));
  for (const required of [
    "@village/contracts",
    "@village/ui",
    "electron",
    "react",
    "zod",
  ]) {
    assert.ok(
      names.has(required),
      `${required} is absent from the release SBOM`,
    );
  }
  for (const excluded of [
    "@village/control-plane",
    "@village/test-auth-site",
    "@village/web",
    "jose",
  ]) {
    assert.equal(
      names.has(excluded),
      false,
      `${excluded} is not in the Mac app`,
    );
  }
  const contracts = bom.dependencies.find(
    (dependency) => dependency.ref === "pkg:npm/%40village/contracts@0.0.0",
  );
  assert.deepEqual(contracts?.dependsOn, ["pkg:npm/zod@4.4.3"]);
  assert.doesNotMatch(
    JSON.stringify(bom),
    /node_modules|(?:\/private)?\/tmp\//,
  );
});
