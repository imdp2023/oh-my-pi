import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { verifyManifest, validatePayload, compareVersions, validateConfig } = require("../content-shell/validation.cjs");
const { ContentStore } = require("../content-shell/storage.cjs");
const { allowedDownload, fetchBytes, createContentUpdateService } = require("../content-shell/download.cjs");
const keys = generateKeyPairSync("ed25519");
const config = {
  schema: 1, version: "1.0.0", shellVersion: "1.0.0", repository: "imdp2023/oh-my-pi",
  compatibility: "a".repeat(64), publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
};
const required = ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html", "agent-runtime/sidecar.js"];
function fixture(version = "1.0.1", extra = [], overrides = {}) {
  const files = [...required.map(path => ({ path, data: Buffer.from(`content ${version}`).toString("base64") })), ...extra];
  const payload = gzipSync(JSON.stringify({ schema: 1, files }));
  const manifest = { schema: 1, version, shellVersion: "1.0.0", compatibility: config.compatibility,
    platform: "darwin", arch: "arm64", artifact: `content-${version}-darwin-arm64.json.gz`,
    size: payload.length, sha256: createHash("sha256").update(payload).digest("hex"), ...overrides };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, keys.privateKey).toString("base64");
  return { files, payload, manifest, bytes, signature };
}
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-content-unit-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { root, store: new ContentStore(join(root, "updates"), config) };
}
function stage(store, f) { store.stage(f.bytes, f.signature, f.payload); }
function server(f) {
  return async (url) => new Response(url.endsWith(".sig") ? f.signature : url.endsWith(".json") ? f.bytes : f.payload);
}

test("manifest must be signed by the fixed shell key before any fields are trusted", () => {
  const f = fixture();
  assert.deepEqual(verifyManifest(f.bytes, f.signature, config), f.manifest);
  assert.throws(() => verifyManifest(Buffer.from(f.bytes.toString().replace("1.0.1", "9.0.0")), f.signature, config), /signature/);
  assert.throws(() => validateConfig({ ...config, publicKey: "" }));
  assert.throws(() => verifyManifest(f.bytes, sign(null, f.bytes, generateKeyPairSync("ed25519").privateKey).toString("base64"), config), /signature/);
});

test("strict stable versions cannot inject paths or be compared lexically", () => {
  assert.equal(compareVersions("1.0.10", "1.0.2"), 1);
  for (const version of ["../a", "01.0.0", "1.0.0-beta.1", "1.0", "1.0.0/evil"]) assert.throws(() => compareVersions(version, "1.0.0"));
});

test("signed manifest still requires correct target, bounded size and exact artifact", () => {
  for (const fields of [{ arch: "x64" }, { platform: "win32" }, { size: 1e12 }, { artifact: "../../escape" }, { sha256: "bad" }]) {
    const f = fixture("1.0.1", [], fields);
    assert.throws(() => verifyManifest(f.bytes, f.signature, config));
  }
});

test("payload corruption and unsafe archive paths fail before extraction", () => {
  const f = fixture();
  assert.equal(validatePayload(f.payload, f.manifest).length, 4);
  assert.throws(() => validatePayload(Buffer.from("bad"), f.manifest), /checksum/);
  for (const path of ["out/../escape", "/out/a", "out/\\escape", "out/.hidden", "out/native.node", "content-shell/launcher.cjs", "OUT/main/index.js", "out/Main/index.js", "out/a//b"]) {
    const bad = fixture("1.0.1", [{ path, data: "YQ==" }]);
    assert.throws(() => validatePayload(bad.payload, bad.manifest), /path/);
  }
});

test("multi-megabyte bundled JavaScript validates without recursive regex overflow", () => {
  const file = { path: "out/main/large-bundle.js", data: Buffer.alloc(4 * 1024 * 1024, 7).toString("base64") };
  const f = fixture("1.0.1", [file]);
  const files = validatePayload(f.payload, f.manifest);
  assert.equal(files.find(entry => entry.path === file.path).data.length, 4 * 1024 * 1024);
});

test("user path: check → download → confirm → new process → healthy, without touching user data", async t => {
  const { root, store } = setup(t);
  const userData = join(root, "user-data.sqlite");
  writeFileSync(userData, "keep my conversations");
  const f = fixture();
  const service = createContentUpdateService(config, store, config.version, server(f));
  assert.deepEqual(await service.check(), { version: "1.0.1", compatible: true });
  await service.download();
  assert.equal(store.readState().pending, null, "download alone cannot activate");
  service.activate();
  const boot = store.selectForBoot();
  assert.equal(boot.version, "1.0.1");
  assert.equal(store.readState().active, null, "trial is not yet the known-good version");
  store.markHealthy(boot.version);
  assert.equal(store.readState().active, "1.0.1");
  const shell = join(root, "shell");
  mkdirSync(join(shell, "node_modules"), { recursive: true });
  const run = store.materialize(boot, shell);
  assert.equal(readFileSync(join(run, "out/main/index.js"), "utf8"), "content 1.0.1");
  assert.equal(readFileSync(userData, "utf8"), "keep my conversations");
  service.dispose();
});

test("unhealthy candidate rolls back on next launch, and is not offered again", async t => {
  const { store } = setup(t);
  stage(store, fixture());
  store.activate("1.0.1", "1.0.0");
  store.markHealthy(store.selectForBoot().version);
  const broken = fixture("1.0.2");
  stage(store, broken);
  store.activate("1.0.2", "1.0.1");
  assert.equal(store.selectForBoot().version, "1.0.2");
  assert.equal(store.selectForBoot().version, "1.0.1");
  const service = createContentUpdateService(config, store, "1.0.1", server(broken));
  assert.equal(await service.check(), null);
  assert.throws(() => store.activate("1.0.2", "1.0.1"), /previously failed/);
  service.dispose();
});

test("incompatible update offers shell upgrade and cannot stage or activate", async t => {
  const { store } = setup(t);
  const f = fixture("1.0.1", [], { compatibility: "b".repeat(64) });
  const service = createContentUpdateService(config, store, "1.0.0", server(f));
  assert.deepEqual(await service.check(), { version: "1.0.1", compatible: false });
  await assert.rejects(service.download(), /compatible/);
  assert.throws(() => stage(store, f), /different shell/);
  service.dispose();
});

test("newer installed shell never loads an older cached payload", t => {
  const { root, store } = setup(t);
  stage(store, fixture());
  store.activate("1.0.1", "1.0.0");
  const upgraded = new ContentStore(join(root, "updates"), { ...config, version: "2.0.0" });
  assert.equal(upgraded.selectForBoot(), null);
  assert.equal(upgraded.readState().pending, null);
});

test("staged corruption preserves known-good release; published version cannot be replaced", t => {
  const { store } = setup(t);
  stage(store, fixture());
  store.activate("1.0.1", "1.0.0");
  store.markHealthy(store.selectForBoot().version);
  stage(store, fixture("1.0.2"));
  store.activate("1.0.2", "1.0.1");
  writeFileSync(join(store.versionDir("1.0.2"), "payload.gz"), "broken");
  assert.equal(store.selectForBoot().version, "1.0.1");
  const replacement = fixture("1.0.1", [{ path: "out/change.txt", data: "YQ==" }]);
  assert.throws(() => stage(store, replacement), /cannot be replaced/);
});

test("managed storage refuses symlink escapes", t => {
  const { root, store } = setup(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(store.root, "versions"));
  assert.throws(() => stage(store, fixture()), /Unsafe/);
  assert.equal(existsSync(join(outside, "1.0.1")), false);
});

test("network allows only HTTPS GitHub release resources, checks redirects and streaming caps", async () => {
  const repository = config.repository;
  assert.equal(allowedDownload(`https://github.com/${repository}/releases/latest/download/a`, repository), true);
  for (const url of ["http://github.com/imdp2023/oh-my-pi/releases/a", "https://github.com/other/repo/releases/a", "https://evil.test/a", "https://user:pass@github.com/imdp2023/oh-my-pi/releases/a"]) assert.equal(allowedDownload(url, repository), false);
  const url = `https://github.com/${repository}/releases/latest/download/a`;
  const opts = { repository, limit: 2, signal: new AbortController().signal };
  await assert.rejects(fetchBytes(url, { ...opts, fetchImpl: async () => new Response("abc") }), /size limit/);
  await assert.rejects(fetchBytes(url, { ...opts, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }) }), /Untrusted/);
});

test("dispose rejects further checks and activation", async t => {
  const { store } = setup(t);
  const service = createContentUpdateService(config, store, "1.0.0", server(fixture()));
  service.dispose();
  await assert.rejects(service.check(), /abort/i);
  assert.throws(() => service.activate(), /abort/i);
});
