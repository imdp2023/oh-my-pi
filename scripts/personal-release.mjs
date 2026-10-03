import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const gzipAsync = promisify(gzip);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const { assertVersion, compareVersions, validateConfig, verifyManifest, validatePayload } = require("../apps/desktop/content-shell/validation.cjs");

export function parseReleaseVersion(value) {
  const config = typeof value === "string" ? JSON.parse(value) : value;
  assertVersion(config?.version);
  if (typeof config.publicKey !== "string") throw new Error("release-version.json publicKey must be a string");
  return config;
}

export function shouldRelease({ before, current, manual = false }) {
  const next = parseReleaseVersion(current);
  if (manual) return true;
  if (!before) return true;
  if (/^0+$/.test(before)) return true;
  const previous = parseReleaseVersion(before);
  if (compareVersions(next.version, previous.version) < 0) throw new Error("Release version must not decrease");
  return previous.version !== next.version;
}

export function assertNewerThanExisting(version, tags) {
  assertVersion(version);
  const released = tags.filter((tag) => tag.startsWith("personal-v")).map((tag) => tag.slice("personal-v".length));
  for (const existing of released) {
    assertVersion(existing);
    if (compareVersions(existing, version) > 0) throw new Error(`Refusing personal release ${version}: newer version ${existing} already exists`);
  }
}

export function validateSigningKeyPair(publicKeyBase64, privateKeyBase64) {
  if (!publicKeyBase64) throw new Error("Set publicKey in release-version.json before building personal releases");
  if (!privateKeyBase64) throw new Error("GitHub Actions secret CONTENT_UPDATE_PRIVATE_KEY is required (base64 PKCS8 DER)");
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
    publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  } catch { throw new Error("Release signing keys must be valid base64 DER keys"); }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing keys must use Ed25519");
  if (!createPublicKey(privateKey).export({ format: "der", type: "spki" }).equals(publicKey.export({ format: "der", type: "spki" }))) throw new Error("CONTENT_UPDATE_PRIVATE_KEY does not match release-version.json publicKey");
  return privateKey;
}

export function verifyAssetNames(version, names) {
  assertVersion(version);
  const expected = [`oh-my-pi-${version}-arm64.dmg`, `oh-my-pi-${version}-arm64-mac.zip`, `content-${version}-darwin-arm64.json.gz`, "content-manifest.json", "content-manifest.sig"].sort();
  const actual = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error("Release asset set is incomplete or contains unexpected files");
}

async function walkFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in content payload: ${absolute}`);
    if (entry.isDirectory()) results.push(...(await walkFiles(absolute)));
    else if (entry.isFile()) results.push(absolute);
  }
  return results;
}

export async function computeCompatibility({ baseDir = root } = {}) {
  const files = new Map();
  const addFile = async (path, normalize = (buffer) => buffer) => {
    const absolute = join(baseDir, path);
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) return;
      files.set(path, normalize(await readFile(absolute)));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  };
  const addTree = async (path) => {
    const absolute = join(baseDir, path);
    try {
      for (const file of await walkFiles(absolute)) {
        const relativePath = relative(baseDir, file).split(sep).join("/");
        let contents = await readFile(file);
        if (relativePath.endsWith("/Cargo.toml") || relativePath === "Cargo.toml") {
          contents = Buffer.from(contents.toString().replace(/^(\s*version\s*=\s*)"[^"]+"/gm, '$1"0.0.0"'));
        }
        files.set(relativePath, contents);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  };
  const normalizePackageManifest = (buffer) => {
    const manifest = JSON.parse(buffer.toString());
    delete manifest.version;
    return Buffer.from(JSON.stringify(manifest));
  };
  await addFile("Cargo.toml", (buffer) => Buffer.from(buffer.toString().replace(/(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, '$1<version>$2')));
  await addFile("Cargo.lock", (buffer) => Buffer.from(buffer.toString().replace(/(name = "host-core"\nversion = ")([^"]+)(")/, '$1<version>$3')));
  await addTree("crates");
  await addTree("apps/desktop/content-shell");
  await addFile("apps/desktop/personal-build.json");
  await addFile("release-version.json", (buffer) => {
    const config = parseReleaseVersion(buffer.toString());
    return Buffer.from(JSON.stringify({ publicKey: config.publicKey }));
  });
  await addFile("packages/shared/src/protocol.ts", (buffer) => Buffer.from(buffer.toString().replace(/(APP_VERSION\s*=\s*")([^"]+)(")/, '$1<version>$3')));
  await addFile("pnpm-lock.yaml");
  await addFile("pnpm-workspace.yaml");
  await addFile("apps/desktop/package.json", normalizePackageManifest);
  await addFile("package.json", normalizePackageManifest);
  const packageEntries = await readdir(join(baseDir, "packages"), { withFileTypes: true });
  for (const entry of packageEntries.filter((item) => item.isDirectory())) {
    await addFile(`packages/${entry.name}/package.json`, normalizePackageManifest);
  }
  for (const path of ["apps/desktop/resources/skills", "apps/desktop/resources/plugins", "apps/desktop/resources/models.dev", "apps/desktop/build"]) await addTree(path);
  // Test/docs changes are not a native ABI change. Only the packaging rules
  // that define the fixed shell join its dependency/source fingerprint.
  for (const path of ["scripts/personal-release.mjs", "scripts/build-desktop-release.mjs"]) await addFile(path);

  const hash = createHash("sha256");
  for (const [path, contents] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

export async function createContentPayload({ version, shellVersion, compatibility, baseDir = root, privateKeyBase64 = process.env.CONTENT_UPDATE_PRIVATE_KEY, publicKeyBase64 } = {}) {
  assertVersion(version);
  assertVersion(shellVersion);
  const privateKey = validateSigningKeyPair(publicKeyBase64, privateKeyBase64);

  const files = [];
  for (const [source, prefix] of [["apps/desktop/out", "out"], ["packages/agent-runtime/dist-bundle", "agent-runtime"]]) {
    const sourceDir = join(baseDir, source);
    for (const file of await walkFiles(sourceDir)) {
      const path = `${prefix}/${relative(sourceDir, file).split(sep).join("/")}`;
      if (!/^(?:out|agent-runtime)\/[A-Za-z0-9_@+., /()-]+$/.test(path) || path.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(" ")) || /\.(node|dylib|so|exe|dll)$/i.test(path)) throw new Error(`Unsafe content path: ${path}`);
      files.push({ path, data: (await readFile(file)).toString("base64") });
    }
  }
  if (!files.some(({ path }) => path.startsWith("out/")) || !files.some(({ path }) => path.startsWith("agent-runtime/"))) throw new Error("Both desktop out/ and agent-runtime dist-bundle/ must contain files");
  for (const required of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html", "agent-runtime/sidecar.js"]) {
    if (!files.some(({ path }) => path === required)) throw new Error(`Missing content entry: ${required}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const payload = Buffer.from(JSON.stringify({ schema: 1, files }));
  const compressed = await gzipAsync(payload, { level: 9, mtime: 0 });

  const artifact = `content-${version}-darwin-arm64.json.gz`;
  const manifest = {
    schema: 1, version, shellVersion, compatibility, platform: "darwin", arch: "arm64",
    artifact, size: compressed.length, sha256: createHash("sha256").update(compressed).digest("hex"),
  };
  validatePayload(compressed, manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, manifestBytes, privateKey).toString("base64");
  verifyManifest(manifestBytes, signature, { publicKey: publicKeyBase64 });
  return { artifact, compressed, manifestBytes, signature };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "trigger") {
    const before = args[0] ? await readFile(args[0], "utf8") : "";
    const current = await readFile(join(root, "release-version.json"), "utf8");
    process.stdout.write(shouldRelease({ before, current, manual: process.env.GITHUB_EVENT_NAME === "workflow_dispatch" }) ? "true\n" : "false\n");
    return;
  }
  if (command === "assert-newer") {
    const release = parseReleaseVersion(await readFile(join(root, "release-version.json"), "utf8"));
    assertNewerThanExisting(release.version, args);
    return;
  }
  const release = parseReleaseVersion(await readFile(join(root, "release-version.json"), "utf8"));
  const build = JSON.parse(await readFile(join(root, "apps/desktop/personal-build.json"), "utf8"));
  if (command === "check-key") {
    validateSigningKeyPair(release.publicKey, process.env.CONTENT_UPDATE_PRIVATE_KEY);
    console.log("Release signing key pair is valid");
    return;
  }
  if (command === "prepare") {
    const key = release.publicKey;
    if (!key) throw new Error("Set publicKey in release-version.json before building personal releases");
    assertVersion(build.shellVersion);
    const compatibility = await computeCompatibility();
    validateConfig({ schema: 1, version: release.version, shellVersion: build.shellVersion, compatibility, repository: build.repository, publicKey: key });
    await writeFile(join(root, "apps/desktop/content-shell-config.json"), `${JSON.stringify({ schema: 1, version: release.version, shellVersion: build.shellVersion, compatibility, repository: build.repository, publicKey: key }, null, 2)}\n`);
    const packageEntries = await readdir(join(root, "packages"), { withFileTypes: true });
    const manifests = ["package.json", "apps/desktop/package.json", ...packageEntries.filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}/package.json`)];
    for (const path of manifests) {
      const file = join(root, path);
      let config;
      try { config = JSON.parse(await readFile(file, "utf8")); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      config.version = release.version;
      if (path === "apps/desktop/package.json") {
        config.homepage = "https://github.com/imdp2023/oh-my-pi";
        config.build = { ...config.build, appId: build.appId, productName: build.productName, publish: [], asar: false, extraMetadata: { ...config.build.extraMetadata, main: "content-shell/launcher.cjs" }, files: [...new Set([...(config.build.files ?? []), "content-shell/**/*", "content-shell-config.json"])], extraResources: [...(config.build.extraResources ?? []), { from: "resources/models.dev", to: "models.dev" }], mac: { ...config.build.mac, identity: "-", notarize: false, artifactName: "oh-my-pi-${version}-${arch}-mac.${ext}" }, dmg: { ...config.build.dmg, artifactName: "oh-my-pi-${version}-${arch}.${ext}" } };
      }
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    }
    const protocolPath = join(root, "packages/shared/src/protocol.ts");
    const protocol = await readFile(protocolPath, "utf8");
    await writeFile(protocolPath, protocol.replace(/(APP_VERSION\s*=\s*")([^"]+)(")/, `$1${release.version}$3`));
    const cargoPath = join(root, "Cargo.toml");
    const cargo = await readFile(cargoPath, "utf8");
    const cargoStart = cargo.indexOf("[workspace.package]");
    const cargoVersion = cargo.indexOf("version = ", cargoStart);
    const cargoEnd = cargo.indexOf("\n", cargoVersion);
    await writeFile(cargoPath, `${cargo.slice(0, cargoVersion)}version = \"${release.version}\"${cargo.slice(cargoEnd)}`);
    const lockPath = join(root, "Cargo.lock");
    const lock = await readFile(lockPath, "utf8");
    const crateStart = lock.indexOf("name = \"host-core\"");
    const lockVersion = lock.indexOf("version = \"", crateStart);
    const lockEnd = lock.indexOf("\n", lockVersion);
    await writeFile(lockPath, `${lock.slice(0, lockVersion)}version = \"${release.version}\"${lock.slice(lockEnd)}`);
    process.stdout.write(`Prepared personal release ${release.version}\n`);
    return;
  }
  if (command === "payload") {
    const shellConfig = JSON.parse(await readFile(join(root, "apps/desktop/content-shell-config.json"), "utf8"));
    validateConfig(shellConfig);
    if (shellConfig.version !== release.version || shellConfig.shellVersion !== build.shellVersion || shellConfig.publicKey !== release.publicKey) throw new Error("Prepared shell does not match this release; prepare again in a clean build workspace");
    const result = await createContentPayload({ version: release.version, shellVersion: build.shellVersion, compatibility: shellConfig.compatibility, publicKeyBase64: release.publicKey });
    await writeFile(join(root, result.artifact), result.compressed);
    await writeFile(join(root, "content-manifest.json"), result.manifestBytes);
    await writeFile(join(root, "content-manifest.sig"), `${result.signature}\n`);
    process.stdout.write(`Created ${result.artifact}\n`);
    return;
  }
  if (command === "verify-assets") {
    verifyAssetNames(release.version, args);
    return;
  }
  throw new Error(`Unknown command: ${command ?? "(missing)"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
