import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyAssetNames } from "../../../scripts/personal-release.mjs";

const read = relative => readFileSync(new URL(relative, import.meta.url), "utf8");

test("oh-my-pi is the shared, packaged and localized application name", () => {
  assert.equal(JSON.parse(read("../personal-build.json")).productName, "oh-my-pi");
  assert.equal(JSON.parse(read("../package.json")).build.productName, "oh-my-pi");
  assert.match(read("../../../packages/shared/src/protocol.ts"), /APP_NAME = "oh-my-pi"/);
  assert.match(read("../index.html"), /<title>oh-my-pi<\/title>/);
  assert.match(read("../content-shell/launcher.cjs"), /app\.setName\("oh-my-pi"\)/);
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"]) {
    const text = read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.match(text, /["']?shellName["']?:\s*"oh-my-pi"/);
    assert.doesNotMatch(text, /PI-Desktop/);
  }
});

test("brand rename retains the personal installation identity and existing profile", () => {
  assert.equal(JSON.parse(read("../personal-build.json")).appId, "io.github.imdp2023.pi-personal");
  const launcher = read("../content-shell/launcher.cjs");
  assert.match(launcher, /join\(app\.getPath\("appData"\), "PI-Desktop Personal"\)/);
  assert.match(launcher, /join\(homedir\(\), "\.pi-desktop-personal"\)/);
  assert.match(read("../electron/main/data-paths.ts"), /DEVELOPMENT_INSTALLATION_NAME = "PI-Desktop Dev"/);
});

test("release validation accepts the renamed artifacts and refuses the old display name", () => {
  const assets = ["oh-my-pi-0.16.1-arm64.dmg", "oh-my-pi-0.16.1-arm64-mac.zip", "content-0.16.1-darwin-arm64.json.gz", "content-manifest.json", "content-manifest.sig"];
  verifyAssetNames("0.16.1", assets);
  assert.throws(() => verifyAssetNames("0.16.1", assets.map(name => name.replace("oh-my-pi", "PI-Desktop-Personal"))));
});
