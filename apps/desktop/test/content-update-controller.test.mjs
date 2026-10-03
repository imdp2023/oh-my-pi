import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const source = await import("../electron/main/content-update-controller.ts");
const { ContentUpdateController } = source;
const { getContentShellBridge } = await import("../electron/main/updater-factory.ts");

test("a malformed personal bridge must not fall back to the upstream updater", () => {
  assert.equal(getContentShellBridge(), null);
  globalThis.__PI_CONTENT_SHELL__ = { version: "1.0.0" };
  try { assert.throws(() => getContentShellBridge(), /Invalid personal/); }
  finally { delete globalThis.__PI_CONTENT_SHELL__; }
});

function createController({ check = async () => null, download = async () => {}, busy = () => null, restart = () => {}, readPreference } = {}) {
  const events = [];
  let activated = 0;
  let healthy = 0;
  let disposed = 0;
  const bridge = {
    version: "1.2.3",
    shellVersion: "9.0.0",
    sidecarPath: null,
    defaultProfile: true,
    check,
    download,
    activate: () => { activated += 1; },
    markHealthy: () => { healthy += 1; },
    dispose: () => { disposed += 1; },
  };
  const logger = { app: (...args) => events.push(["log", ...args]) };
  const controller = new ContentUpdateController({
    bridge,
    logger,
    send: (channel, payload) => events.push([channel, payload]),
    getBusyReason: busy,
    getLocale: () => "en",
    showNativeMessage: async () => 1,
    relaunchAndQuit: restart,
    readUpdatePreference: readPreference,
    openExternal: async () => {},
  });
  return { controller, events, bridge, values: () => ({ activated, healthy, disposed }) };
}

test("manual checks expose available content without downloading; automatic checks coalesce and download once", async () => {
  let checks = 0;
  let downloads = 0;
  const manual = createController({ check: async () => { checks += 1; return { version: "1.2.4", compatible: true }; } });
  manual.controller.setPreference("manual");
  const state = await manual.controller.check({ manual: true });
  assert.equal(checks, 1);
  assert.equal(state.status, "available");
  assert.equal(state.currentVersion, "1.2.3");

  let releaseCheck;
  const automatic = createController({
    check: () => new Promise((resolve) => { releaseCheck = resolve; }),
    download: async (progress) => { downloads += 1; progress(42.5); },
  });
  const first = automatic.controller.check();
  const second = automatic.controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  releaseCheck({ version: "1.2.4", compatible: true });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(downloads, 1);
  assert.equal(one.status, "downloaded");
  assert.equal(two.status, "downloaded");
  assert.equal(one.progressPercent, 100);
});

test("incompatible manifests and failed downloads remain visible without changing running version", async () => {
  const incompatible = createController({ check: async () => ({ version: "2.0.0", compatible: false }) });
  const incompatibleState = await incompatible.controller.check({ manual: true });
  assert.equal(incompatibleState.status, "available");
  assert.equal(incompatibleState.mode, "manual");
  assert.equal(incompatibleState.currentVersion, "1.2.3");

  const failed = createController({
    check: async () => ({ version: "1.2.4", compatible: true }),
    download: async () => { throw new Error("verified payload unavailable"); },
  });
  const failedState = await failed.controller.check();
  assert.equal(failedState.status, "error");
  assert.equal(failedState.availableVersion, "1.2.4");
  assert.equal(failedState.currentVersion, "1.2.3");
  assert.match(failedState.error, /verified payload unavailable/);
});

test("install refuses active work and activates only when idle; dispose blocks late progress", async () => {
  const active = createController({
    check: async () => ({ version: "1.2.4", compatible: true }),
    busy: () => "An agent task is still active.",
  });
  active.controller.setPreference("manual");
  await active.controller.check({ manual: true });
  await active.controller.download();
  assert.doesNotThrow(() => active.controller.install());
  assert.equal(active.values().activated, 0);
  assert.equal(active.controller.getState().status, "downloaded");

  let reportProgress;
  let finishDownload;
  const idle = createController({
    check: async () => ({ version: "1.2.4", compatible: true }),
    download: (progress) => {
      reportProgress = progress;
      return new Promise((resolve) => { finishDownload = resolve; });
    },
  });
  idle.controller.setPreference("manual");
  await idle.controller.check({ manual: true });
  const pending = idle.controller.download();
  idle.controller.dispose();
  reportProgress(75);
  assert.equal(idle.controller.getState().status, "downloading");
  assert.equal(idle.values().disposed, 1);
  finishDownload();
  await pending;
});

test("repeated install requests activate only once", async () => {
  const idle = createController({
    check: async () => ({ version: "1.2.4", compatible: true }),
  });
  idle.controller.setPreference("manual");
  await idle.controller.check({ manual: true });
  await idle.controller.download();
  idle.controller.install();
  idle.controller.install();
  assert.equal(idle.values().activated, 1);
  assert.equal(idle.controller.isInstallingUpdate(), true);
});

test("stored manual preference does not silently start a download", async () => {
  let downloads = 0;
  const { controller } = createController({
    readPreference: async () => "manual",
    check: async () => ({ version: "1.2.4", compatible: true }),
    download: async () => { downloads += 1; },
  });
  const state = await controller.check();
  assert.equal(state.preference, "manual");
  assert.equal(state.status, "available");
  assert.equal(downloads, 0);
});

test("restart failure remains retryable and default-profile restart retains managed storage", async () => {
  let attempts = 0;
  const { controller } = createController({
    check: async () => ({ version: "1.2.4", compatible: true }),
    restart: args => {
      assert.ok(args.includes("--pi-managed-storage"));
      if (++attempts === 1) throw new Error("restart unavailable");
    },
  });
  await controller.check();
  controller.install();
  assert.equal(controller.isInstallingUpdate(), false);
  assert.equal(controller.getState().status, "downloaded");
  assert.match(controller.getState().error, /restart unavailable/);
  controller.install();
  assert.equal(controller.isInstallingUpdate(), true);
  assert.equal(attempts, 2);
});
