#!/usr/bin/env node
// Exercises the real fixed bootstrap in isolated Electron processes. No app
// instance, credentials, provider or GitHub service belonging to a user is used.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { ContentStore } = require("../apps/desktop/content-shell/storage.cjs");
const { createContentUpdateService } = require("../apps/desktop/content-shell/download.cjs");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-content-electron-")));
const shell = join(temp, "shell");
const profile = join(temp, "profile");
const userData = join(temp, "user-data");
const keys = generateKeyPairSync("ed25519");
const config = { schema: 1, version: "1.0.0", shellVersion: "1.0.0", repository: "imdp2023/oh-my-pi",
  compatibility: "c".repeat(64), publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") };

function content(version) {
  const source = `import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { marker } from 'frozen-fixture';
const bridge = globalThis.__PI_CONTENT_SHELL__;
app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  const text = await window.webContents.executeJavaScript('document.body.textContent');
  if (!text.includes('${version}') || marker !== 'frozen-native-contract') throw new Error('mixed content/dependencies');
  console.log('CONTENT_PROBE ' + JSON.stringify({version:bridge.version,text,marker,appPath:app.getAppPath()}));
  if (process.env.PI_CONTENT_FIXTURE_FAIL === bridge.version) { app.exit(3); return; }
  bridge.markHealthy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });`;
  return [
    { path: "out/main/index.js", data: Buffer.from(source).toString("base64") },
    { path: "out/preload/index.cjs", data: "" },
    { path: "out/renderer/index.html", data: Buffer.from('<body><script type="module" src="./chunk.js"></script></body>').toString("base64") },
    { path: "out/renderer/chunk.js", data: Buffer.from(`document.body.append('Release ${version}');`).toString("base64") },
    { path: "agent-runtime/sidecar.js", data: Buffer.from("// fixture").toString("base64") },
  ];
}
function fixture(version) {
  const payload = gzipSync(JSON.stringify({ schema: 1, files: content(version) }));
  const manifest = { schema: 1, version, shellVersion: config.shellVersion, compatibility: config.compatibility,
    platform: "darwin", arch: "arm64", artifact: `content-${version}-darwin-arm64.json.gz`,
    size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { payload, bytes, signature: sign(null, bytes, keys.privateKey).toString("base64") };
}
async function boot(expected, fail = false) {
  const { electronBinary } = resolveElectronBinary(repository);
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: userData, PI_CONTENT_FIXTURE_FAIL: fail ? expected : "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [shell, `--user-data-dir=${profile}`], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, fail ? 3 : 0, output.slice(-5000));
    const line = output.split("\n").find(line => line.startsWith("CONTENT_PROBE "));
    assert.ok(line, output.slice(-5000));
    const result = JSON.parse(line.slice("CONTENT_PROBE ".length));
    assert.equal(result.version, expected);
    assert.ok(result.text.includes(expected));
    assert.equal(result.marker, "frozen-native-contract");
    return result;
  } finally { clearTimeout(timer); }
}

try {
  for (const dir of [shell, profile, userData]) mkdirSync(dir, { recursive: true });
  cpSync(join(repository, "apps/desktop/content-shell"), join(shell, "content-shell"), { recursive: true });
  writeFileSync(join(shell, "content-shell-config.json"), JSON.stringify(config));
  writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "content-fixture", version: config.version, type: "module", main: "content-shell/launcher.cjs" }));
  mkdirSync(join(shell, "node_modules/frozen-fixture"), { recursive: true });
  writeFileSync(join(shell, "node_modules/frozen-fixture/package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  writeFileSync(join(shell, "node_modules/frozen-fixture/index.js"), "export const marker = 'frozen-native-contract';");
  for (const file of content("1.0.0")) {
    mkdirSync(dirname(join(shell, file.path)), { recursive: true });
    writeFileSync(join(shell, file.path), Buffer.from(file.data, "base64"));
  }
  writeFileSync(join(userData, "conversation-sentinel"), "do not replace user data");
  const embedded = await boot("1.0.0");
  assert.equal(embedded.appPath, shell);
  const store = new ContentStore(join(profile, "content-updates"), config);
  const f = fixture("1.0.1");
  const service = createContentUpdateService(config, store, "1.0.0", async url => new Response(url.endsWith(".sig") ? f.signature : url.endsWith(".json") ? f.bytes : f.payload));
  assert.equal((await service.check()).compatible, true);
  await service.download();
  assert.equal(store.readState().pending, null);
  service.activate();
  service.dispose();
  const updated = await boot("1.0.1");
  assert.notEqual(updated.appPath, shell);
  assert.equal(store.readState().active, "1.0.1");
  const broken = fixture("1.0.2");
  store.stage(broken.bytes, broken.signature, broken.payload);
  store.activate("1.0.2", "1.0.1");
  await boot("1.0.2", true);
  await boot("1.0.1");
  assert.ok(store.readState().failed.includes("1.0.2"));
  assert.equal(readFileSync(join(userData, "conversation-sentinel"), "utf8"), "do not replace user data");
  assert.ok(readFileSync(join(shell, "out/main/index.js"), "utf8").includes("'1.0.0'"));
  console.log("PASS: real Electron bootstrap, module dependencies, renderer chunks, content-only upgrade, failed-start rollback, immutable shell and user-data preservation");
} finally {
  rmSync(temp, { force: true, recursive: true });
}
