import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createContentPayload, shouldRelease, parseReleaseVersion, computeCompatibility, validateSigningKeyPair, verifyAssetNames, assertNewerThanExisting } from "./personal-release.mjs";

const gunzipAsync = promisify(gunzip);
assert.equal(shouldRelease({ before: '{"version":"1.2.3","publicKey":""}', current: '{"version":"1.2.3","publicKey":"key"}' }), false);
assert.equal(shouldRelease({ before: '{"version":"1.2.2","publicKey":""}', current: '{"version":"1.2.3","publicKey":""}' }), true);
assert.equal(shouldRelease({ before: "", current: '{"version":"1.2.3","publicKey":""}' }), true);
assert.equal(shouldRelease({ before: "invalid", current: '{"version":"1.2.3","publicKey":""}', manual: true }), true);
for (const version of ["01.2.3", "1.2.3-rc.1", "../1.2.3", "1.2"]) assert.throws(() => parseReleaseVersion({ version, publicKey: "" }));
assert.throws(() => shouldRelease({ before: '{"version":"1.2.4","publicKey":""}', current: '{"version":"1.2.3","publicKey":""}' }), /decrease/);
assert.throws(() => assertNewerThanExisting("1.2.3", ["personal-v1.2.4"]), /newer/);
assert.doesNotThrow(() => assertNewerThanExisting("1.2.3", ["personal-v1.2.2", "upstream-v99.0.0"]));

const directory = await mkdtemp(join(tmpdir(), "personal-release-test-"));
try {
  await mkdir(join(directory, "apps/desktop/out"), { recursive: true });
  await mkdir(join(directory, "packages/agent-runtime/dist-bundle/chunks"), { recursive: true });
  await mkdir(join(directory, "apps/desktop/out/main"), { recursive: true });
  await mkdir(join(directory, "apps/desktop/out/preload"), { recursive: true });
  await mkdir(join(directory, "apps/desktop/out/renderer"), { recursive: true });
  await writeFile(join(directory, "apps/desktop/out/main/index.js"), "shell");
  await writeFile(join(directory, "apps/desktop/out/preload/index.cjs"), "preload");
  await writeFile(join(directory, "apps/desktop/out/renderer/index.html"), "renderer");
  await writeFile(join(directory, "packages/agent-runtime/dist-bundle/sidecar.js"), "runtime");
  await writeFile(join(directory, "packages/agent-runtime/dist-bundle/chunks/jiti.js"), "stable dependency");
  await writeFile(join(directory, "packages/agent-runtime/dist-bundle/sidecar.js"), "sidecar");
  const keys = generateKeyPairSync("ed25519");
  const privateKeyBase64 = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const publicKeyBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.throws(() => validateSigningKeyPair(publicKeyBase64, ""), /required/);
  const otherKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.throws(() => validateSigningKeyPair(publicKeyBase64, otherKey), /does not match/);
  const result = await createContentPayload({ version: "1.2.3", shellVersion: "1.0.0", compatibility: "a".repeat(64), baseDir: directory, privateKeyBase64, publicKeyBase64 });
  const manifest = JSON.parse(result.manifestBytes.toString());
  assert.equal(manifest.artifact, "content-1.2.3-darwin-arm64.json.gz");
  assert.equal(manifest.size, result.compressed.length);
  assert.equal(manifest.sha256, (await import("node:crypto")).createHash("sha256").update(result.compressed).digest("hex"));
  assert.equal((await import("node:crypto")).verify(null, result.manifestBytes, keys.publicKey, Buffer.from(result.signature, "base64")), true);
  const payload = JSON.parse((await gunzipAsync(result.compressed)).toString());
  assert.deepEqual(payload.files.map(({ path }) => path), ["agent-runtime/chunks/jiti.js", "agent-runtime/sidecar.js", "out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]);
  const assets = ["PI-Desktop-Personal-1.2.3-arm64.dmg", "PI-Desktop-Personal-1.2.3-arm64-mac.zip", result.artifact, "content-manifest.json", "content-manifest.sig"];
  verifyAssetNames("1.2.3", assets);
  assert.throws(() => verifyAssetNames("1.2.3", assets.slice(1)), /asset set/);
  assert.throws(() => verifyAssetNames("1.2.3", [...assets, "private-key.pem"]), /asset set/);

  await mkdir(join(directory, "crates/host-core/src"), { recursive: true });
  await mkdir(join(directory, "packages/shared/src"), { recursive: true });
  await mkdir(join(directory, "apps/desktop/content-shell"), { recursive: true });
  await writeFile(join(directory, "release-version.json"), JSON.stringify({ version: "1.2.3", publicKey: publicKeyBase64 }));
  await writeFile(join(directory, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.3", dependencies: { native: "1.0.0" } }));
  await writeFile(join(directory, "Cargo.toml"), '[workspace.package]\nversion = "1.2.3"\n');
  await writeFile(join(directory, "Cargo.lock"), 'name = "host-core"\nversion = "1.2.3"\n');
  await writeFile(join(directory, "packages/shared/src/protocol.ts"), 'export const APP_VERSION = "1.2.3";\nexport const PROTOCOL_VERSION = 1;');
  await writeFile(join(directory, "crates/host-core/src/lib.rs"), "// stable native contract");
  const baseline = await computeCompatibility({ baseDir: directory });
  for (const relative of ["release-version.json", "apps/desktop/package.json", "Cargo.toml", "Cargo.lock", "packages/shared/src/protocol.ts"]) {
    const file = join(directory, relative);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("1.2.3", "1.2.4"));
  }
  await writeFile(join(directory, "apps/desktop/out/main/index.js"), "new compatible JS");
  await mkdir(join(directory, "scripts"));
  await writeFile(join(directory, "scripts/e2e-example.mjs"), "// new UI regression test");
  assert.equal(await computeCompatibility({ baseDir: directory }), baseline, "version/JS changes must remain content-compatible");
  await writeFile(join(directory, "crates/host-core/src/lib.rs"), "// changed database/native contract");
  assert.notEqual(await computeCompatibility({ baseDir: directory }), baseline, "native changes require a shell upgrade");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Personal release checks passed");
