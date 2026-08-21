import { chmod, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(
  root,
  "apps",
  "desktop",
  "native",
  "macos-secure-enclave",
  "main.swift",
);
const output = join(
  root,
  "apps",
  "desktop",
  "dist",
  "native",
  "village-secure-enclave",
);

if (process.platform === "darwin") {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  await run("xcrun", [
    "swiftc",
    source,
    "-O",
    "-target",
    `${architecture}-apple-macosx12.0`,
    "-o",
    output,
  ]);
  await chmod(output, 0o700);
}

function run(file, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("SECURE_ENCLAVE_HELPER_BUILD_FAILED"));
    });
  });
}
