"use strict";

const { createHash, createPublicKey, verify } = require("node:crypto");
const { gunzipSync } = require("node:zlib");

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const HASH = /^[a-f0-9]{64}$/;

function assertVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error("Invalid release version");
  return value;
}

function compareVersions(left, right) {
  const a = assertVersion(left).split(".").map(Number);
  const b = assertVersion(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 encoding");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw new Error("Noncanonical base64 encoding");
  return data;
}

function publicKeyFor(config) {
  const key = createPublicKey({ key: decodeBase64(config.publicKey), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 update key is required");
  return key;
}

function validateConfig(config) {
  if (!config || config.schema !== 1 || config.repository !== "imdp2023/oh-my-pi" || !HASH.test(config.compatibility)) {
    throw new Error("Invalid personal shell configuration");
  }
  assertVersion(config.version);
  assertVersion(config.shellVersion);
  publicKeyFor(config);
  return config;
}

function verifyManifest(bytes, signature, config) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16384) throw new Error("Invalid manifest size");
  const sig = decodeBase64(signature.trim());
  if (sig.length !== 64 || !verify(null, bytes, publicKeyFor(config), sig)) throw new Error("Update signature verification failed");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || value.schema !== 1 || value.platform !== "darwin" || value.arch !== "arm64" || !HASH.test(value.sha256) || !HASH.test(value.compatibility)) {
    throw new Error("Invalid update manifest");
  }
  assertVersion(value.version);
  assertVersion(value.shellVersion);
  if (value.artifact !== `content-${value.version}-darwin-arm64.json.gz`) throw new Error("Invalid update artifact");
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_PACKAGE_BYTES) throw new Error("Invalid update size");
  return value;
}

function isCompatible(manifest, config) {
  return manifest.shellVersion === config.shellVersion && manifest.compatibility === config.compatibility;
}

function validatePayload(bytes, manifest) {
  if (bytes.length !== manifest.size || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new Error("Update checksum verification failed");
  }
  const payload = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }).toString("utf8"));
  if (!payload || payload.schema !== 1 || !Array.isArray(payload.files) || payload.files.length > 25000) {
    throw new Error("Invalid update payload");
  }
  const seen = new Set();
  const files = [];
  let size = 0;
  for (const file of payload.files) {
    const name = file?.path;
    // Archive paths are deliberately narrower than general POSIX paths. No
    // symlinks, traversal, case collisions, hidden entries or native code.
    if (typeof name !== "string" || name.length > 512 || !/^(out|agent-runtime)\/[A-Za-z0-9_@+., /()-]+$/.test(name) ||
        name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(" ")) ||
        /\.(node|dylib|so|exe|dll)$/i.test(name) || seen.has(name.toLowerCase())) {
      throw new Error("Unsafe or duplicate content path");
    }
    seen.add(name.toLowerCase());
    const data = decodeBase64(file.data);
    size += data.length;
    if (size > MAX_EXPANDED_BYTES) throw new Error("Expanded update is too large");
    files.push({ path: name, data });
  }
  for (const required of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html", "agent-runtime/sidecar.js"]) {
    if (!files.some((file) => file.path === required)) throw new Error(`Missing content entry: ${required}`);
  }
  return files;
}

module.exports = { MAX_PACKAGE_BYTES, MAX_EXPANDED_BYTES, assertVersion, compareVersions, validateConfig, verifyManifest, isCompatible, validatePayload };
