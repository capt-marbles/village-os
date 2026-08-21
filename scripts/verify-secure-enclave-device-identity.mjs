import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyPackagedSecureEnclave(
  applicationPath = path.join(
    root,
    "apps/desktop/dist",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Village.app",
  ),
) {
  await verifyPackagedMac(applicationPath);
  const helperPath = path.join(
    applicationPath,
    "Contents/Resources/app.asar.unpacked/dist/native/village-secure-enclave",
  );
  const metadata = await lstat(helperPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_HELPER_UNSAFE");
  }
  await verifyMinimumSystemVersion(applicationPath, helperPath);
  const status = await runHelper(helperPath, { operation: "status" });
  if (status?.available !== true) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_UNAVAILABLE");
  }
  const created = await runHelper(helperPath, { operation: "create" });
  assertCreated(created);
  const restored = await runHelper(helperPath, {
    operation: "publicKey",
    wrappedKey: created.wrappedKey,
  });
  if (
    JSON.stringify(restored?.publicKey) !== JSON.stringify(created.publicKey)
  ) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_KEY_CHANGED");
  }
  const payload = new TextEncoder().encode(
    "village-packaged-secure-enclave-proof-v1",
  );
  const signed = await runHelper(helperPath, {
    operation: "sign",
    wrappedKey: created.wrappedKey,
    payload: Buffer.from(payload).toString("base64url"),
  });
  if (!/^[A-Za-z0-9_-]{86}$/.test(signed?.signature ?? "")) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_SIGNATURE_INVALID");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    created.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signed.signature, "base64url"),
    payload,
  );
  if (!verified) throw new Error("PACKAGED_SECURE_ENCLAVE_SIGNATURE_INVALID");
  return {
    helper: "PACKAGED",
    protection: "HARDWARE_NON_EXPORTABLE",
    algorithm: "ES256",
    signature: "VERIFIED",
    privateKeyExposed: false,
  };
}

async function verifyMinimumSystemVersion(applicationPath, helperPath) {
  const infoPlist = await readFile(
    path.join(applicationPath, "Contents/Info.plist"),
  );
  const appMinimum = await runOutput(
    "plutil",
    ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", "-"],
    infoPlist,
  );
  const loadCommands = await runOutput("otool", ["-l", helperPath]);
  const helperMinimum = parseMinimumSystemVersion(loadCommands);
  if (compareVersions(helperMinimum, appMinimum.trim()) > 0) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_MINIMUM_SYSTEM_MISMATCH");
  }
}

export function parseMinimumSystemVersion(loadCommands) {
  const versions = [
    ...loadCommands.matchAll(/^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$/gm),
  ].map((match) => match[1]);
  if (versions.length !== 1) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_MINIMUM_SYSTEM_INVALID");
  }
  return versions[0];
}

export function compareVersions(left, right) {
  const normalize = (value) => value.split(".").map(Number);
  const leftParts = normalize(left);
  const rightParts = normalize(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function assertCreated(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !/^[A-Za-z0-9_-]{8,16384}$/.test(candidate.wrappedKey ?? "") ||
    candidate.publicKey?.kty !== "EC" ||
    candidate.publicKey?.crv !== "P-256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.publicKey?.x ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.publicKey?.y ?? "")
  ) {
    throw new Error("PACKAGED_SECURE_ENCLAVE_CREATE_INVALID");
  }
}

function runHelper(helperPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const fail = (code) => finish(() => reject(new Error(code)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      fail("PACKAGED_SECURE_ENCLAVE_TIMEOUT");
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 65_536) {
        child.kill("SIGKILL");
        fail("PACKAGED_SECURE_ENCLAVE_RESPONSE_TOO_LARGE");
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.on("error", () => fail("PACKAGED_SECURE_ENCLAVE_HELPER_FAILED"));
    child.on("close", (code) => {
      if (code !== 0) {
        fail("PACKAGED_SECURE_ENCLAVE_HELPER_FAILED");
        return;
      }
      finish(() => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("PACKAGED_SECURE_ENCLAVE_RESPONSE_INVALID"));
        }
      });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function runOutput(file, arguments_, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", () =>
      reject(new Error("PACKAGED_SECURE_ENCLAVE_INSPECTION_FAILED")),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else
        reject(
          new Error(
            `PACKAGED_SECURE_ENCLAVE_INSPECTION_FAILED:${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await verifyPackagedSecureEnclave(process.argv[2]);
  console.log(JSON.stringify(report));
}
