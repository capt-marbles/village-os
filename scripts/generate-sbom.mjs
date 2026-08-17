import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Version } from "@cyclonedx/cyclonedx-library/Spec";
import { JsonStrictValidator } from "@cyclonedx/cyclonedx-library/Validation";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function packageUrl(name, version) {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (separator === -1) throw new Error("SBOM_COMPONENT_INVALID");
    return `pkg:npm/${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function componentKey(component) {
  return `${component.name}@${component.version}`;
}

function safeDistributionUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("SBOM_DISTRIBUTION_URL_UNSAFE");
  }
  return url.href;
}

function normalizeInventoryComponent(component) {
  if (
    !component ||
    typeof component.name !== "string" ||
    component.name.length === 0 ||
    typeof component.version !== "string" ||
    component.version.length === 0 ||
    typeof component.license !== "string" ||
    component.license.length === 0 ||
    !["application", "framework", "library"].includes(component.kind) ||
    !Array.isArray(component.dependencies) ||
    !component.dependencies.every(
      (dependency) => typeof dependency === "string" && dependency.length > 0,
    )
  ) {
    throw new Error("SBOM_COMPONENT_INVALID");
  }
  return {
    name: component.name,
    version: component.version,
    license: component.license,
    kind: component.kind,
    dependencies: [...new Set(component.dependencies)].sort(),
    ...(component.resolved
      ? { resolved: safeDistributionUrl(component.resolved) }
      : {}),
  };
}

function toCycloneDxComponent(component) {
  const purl = packageUrl(component.name, component.version);
  const distributionUrl = safeDistributionUrl(component.resolved);
  return {
    type: component.kind,
    "bom-ref": purl,
    name: component.name,
    version: component.version,
    purl,
    licenses: [{ expression: component.license }],
    ...(distributionUrl
      ? {
          externalReferences: [
            {
              type: "distribution",
              url: distributionUrl,
            },
          ],
        }
      : {}),
  };
}

export function createCycloneDxBom(inventory) {
  const root = normalizeInventoryComponent(inventory?.root);
  if (!Array.isArray(inventory.components)) {
    throw new Error("SBOM_COMPONENT_INVALID");
  }
  const byKey = new Map();
  for (const candidate of [root, ...inventory.components]) {
    const component = normalizeInventoryComponent(candidate);
    const key = componentKey(component);
    const existing = byKey.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(component)) {
      throw new Error("SBOM_COMPONENT_CONFLICT");
    }
    byKey.set(key, component);
  }
  for (const component of byKey.values()) {
    if (component.dependencies.some((dependency) => !byKey.has(dependency))) {
      throw new Error("SBOM_DEPENDENCY_MISSING");
    }
  }

  const rootKey = componentKey(root);
  const components = [...byKey.entries()]
    .filter(([key]) => key !== rootKey)
    .map(([, component]) => component)
    .sort((left, right) =>
      componentKey(left).localeCompare(componentKey(right)),
    );
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: toCycloneDxComponent(inventory.root),
      tools: {
        components: [
          {
            type: "application",
            name: "Village SBOM Generator",
            version: "1",
          },
        ],
      },
    },
    components: components.map(toCycloneDxComponent),
    dependencies: [root, ...components]
      .map((component) => ({
        ref: packageUrl(component.name, component.version),
        dependsOn: [...new Set(component.dependencies)]
          .sort()
          .map((dependency) => {
            const target = byKey.get(dependency);
            return packageUrl(target.name, target.version);
          }),
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  };
  validateCycloneDxBom(bom);
  return bom;
}

export function validateCycloneDxBom(bom) {
  if (
    bom?.bomFormat !== "CycloneDX" ||
    bom.specVersion !== "1.6" ||
    bom.version !== 1 ||
    !bom.metadata?.component ||
    !Array.isArray(bom.components) ||
    !Array.isArray(bom.dependencies)
  ) {
    throw new Error("SBOM_DOCUMENT_INVALID");
  }
  const components = [bom.metadata.component, ...bom.components];
  const references = new Set();
  for (const component of components) {
    if (
      typeof component["bom-ref"] !== "string" ||
      typeof component.name !== "string" ||
      typeof component.version !== "string" ||
      !Array.isArray(component.licenses) ||
      component.licenses.length !== 1 ||
      typeof component.licenses[0]?.expression !== "string" ||
      component.licenses[0].expression.length === 0 ||
      references.has(component["bom-ref"])
    ) {
      throw new Error("SBOM_DOCUMENT_INVALID");
    }
    references.add(component["bom-ref"]);
  }
  for (const dependency of bom.dependencies) {
    if (
      !references.has(dependency.ref) ||
      !Array.isArray(dependency.dependsOn) ||
      dependency.dependsOn.some((reference) => !references.has(reference))
    ) {
      throw new Error("SBOM_DOCUMENT_INVALID");
    }
  }
  if (/node_modules|(?:\/private)?\/tmp\//.test(JSON.stringify(bom))) {
    throw new Error("SBOM_LOCAL_PATH_EXPOSED");
  }
  return bom;
}

export async function validateOfficialCycloneDxBom(bom) {
  const error = await new JsonStrictValidator(Version.v1dot6).validate(
    JSON.stringify(bom),
  );
  if (error !== null) {
    throw new Error("SBOM_CYCLONEDX_SCHEMA_INVALID", { cause: error });
  }
  return bom;
}

function dependencyCollections(node) {
  return [node.dependencies, node.optionalDependencies].filter(Boolean);
}

export function requireExactElectronVersion(installedVersion, builderVersion) {
  if (
    typeof installedVersion !== "string" ||
    typeof builderVersion !== "string" ||
    installedVersion !== builderVersion
  ) {
    throw new Error("SBOM_ELECTRON_VERSION_DRIFT");
  }
  return builderVersion;
}

async function manifestFor(
  node,
  { workspaceLicense, workspacePaths, manifestCache },
) {
  if (!node.path) throw new Error("SBOM_COMPONENT_PATH_MISSING");
  let manifestPromise = manifestCache.get(node.path);
  if (!manifestPromise) {
    manifestPromise = readFile(
      path.join(node.path, "package.json"),
      "utf8",
    ).then(JSON.parse);
    manifestCache.set(node.path, manifestPromise);
  }
  const manifest = await manifestPromise;
  const license =
    typeof manifest.license === "string"
      ? manifest.license
      : manifest.private === true && workspacePaths.has(node.path)
        ? workspaceLicense
        : undefined;
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    typeof license !== "string"
  ) {
    throw new Error("SBOM_COMPONENT_METADATA_MISSING");
  }
  return { ...manifest, license };
}

async function collectNode(
  node,
  kind,
  components,
  context,
  visiting = new Set(),
) {
  const resolvedNode = context.workspaceProjectsByPath.get(node.path) ?? node;
  const manifest = await manifestFor(resolvedNode, context);
  const key = `${manifest.name}@${manifest.version}`;
  if (visiting.has(key)) return key;
  visiting.add(key);
  const dependencies = [];
  for (const collection of dependencyCollections(resolvedNode)) {
    for (const dependency of Object.values(collection)) {
      dependencies.push(
        await collectNode(dependency, "library", components, context, visiting),
      );
    }
  }
  visiting.delete(key);
  const component = {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    kind,
    dependencies: [...new Set(dependencies)].sort(),
    ...(typeof resolvedNode.resolved === "string"
      ? { resolved: safeDistributionUrl(resolvedNode.resolved) }
      : {}),
  };
  const existing = components.get(key);
  if (existing) {
    existing.dependencies = [
      ...new Set([...existing.dependencies, ...component.dependencies]),
    ].sort();
    if (!existing.resolved && component.resolved) {
      existing.resolved = component.resolved;
    }
  } else {
    components.set(key, component);
  }
  return key;
}

export async function collectVillageSbomInventory(root = repositoryRoot) {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["list", "--recursive", "--prod", "--json", "--depth", "Infinity"],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  const projects = JSON.parse(stdout);
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("SBOM_PACKAGE_GRAPH_MISSING");
  }
  const components = new Map();
  const repositoryProject = projects.find((project) => project.path === root);
  if (!repositoryProject) throw new Error("SBOM_ROOT_PROJECT_MISSING");
  const repositoryManifest = await manifestFor(repositoryProject, {
    workspaceLicense: undefined,
    workspacePaths: new Set(),
    manifestCache: new Map(),
  });
  const desktopPath = path.join(root, "apps/desktop");
  const desktopProject = projects.find(
    (project) => project.path === desktopPath,
  );
  if (!desktopProject) throw new Error("SBOM_DESKTOP_COMPONENT_MISSING");
  const context = {
    workspaceLicense: repositoryManifest.license,
    workspacePaths: new Set(
      projects
        .filter((project) => project !== repositoryProject)
        .map((project) => project.path),
    ),
    manifestCache: new Map(),
    workspaceProjectsByPath: new Map(
      projects.map((project) => [project.path, project]),
    ),
  };
  const desktopManifest = await manifestFor(desktopProject, context);
  const desktopDependencies = [];
  for (const collection of dependencyCollections(desktopProject)) {
    for (const dependency of Object.values(collection)) {
      desktopDependencies.push(
        await collectNode(dependency, "library", components, context),
      );
    }
  }

  const desktopRequire = createRequire(
    path.join(root, "apps/desktop/package.json"),
  );
  const electronManifestPath = desktopRequire.resolve("electron/package.json");
  const electronManifest = JSON.parse(
    await readFile(electronManifestPath, "utf8"),
  );
  const builderConfig = parseYaml(
    await readFile(
      path.join(root, "apps/desktop/electron-builder.yml"),
      "utf8",
    ),
  );
  const electronVersion = requireExactElectronVersion(
    electronManifest.version,
    builderConfig?.electronVersion,
  );
  const electronKey = `${electronManifest.name}@${electronVersion}`;
  components.set(electronKey, {
    name: electronManifest.name,
    version: electronVersion,
    license: electronManifest.license,
    kind: "framework",
    dependencies: [],
  });
  desktopDependencies.push(electronKey);

  return {
    root: {
      name: desktopManifest.name,
      version: desktopManifest.version,
      license: desktopManifest.license,
      kind: "application",
      dependencies: [...new Set(desktopDependencies)].sort(),
    },
    components: [...components.values()],
  };
}

export async function generateVillageSbom({
  root = repositoryRoot,
  output = path.join(root, "release/sbom/village.cdx.json"),
  checkOnly = false,
} = {}) {
  const bom = createCycloneDxBom(await collectVillageSbomInventory(root));
  await validateOfficialCycloneDxBom(bom);
  if (!checkOnly) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, {
      mode: 0o644,
    });
  }
  return bom;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes("--check");
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex !== -1 && !output) {
    throw new Error("SBOM_OUTPUT_REQUIRED");
  }
  const bom = await generateVillageSbom({
    checkOnly,
    ...(output ? { output: path.resolve(output) } : {}),
  });
  console.log(
    checkOnly
      ? `SBOM audit passed for ${bom.components.length + 1} components.`
      : `Wrote CycloneDX SBOM for ${bom.components.length + 1} components.`,
  );
}
