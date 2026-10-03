"use strict";

// This bootstrap is part of the fixed shell, never loaded from an update.
const { app } = require("electron");
const fs = require("node:fs");
const { join, dirname } = require("node:path");
const { homedir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { validateConfig } = require("./validation.cjs");
const { ContentStore, readRegular } = require("./storage.cjs");
const { createContentUpdateService } = require("./download.cjs");

try {
  const shellRoot = dirname(__dirname);
  const config = validateConfig(JSON.parse(readRegular(join(shellRoot, "content-shell-config.json"), 16384)));
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This personal shell requires macOS arm64");
  const defaultProfile = process.argv.includes("--pi-managed-storage") || !process.env.PI_DESKTOP_DATA_DIR;
  app.setName("oh-my-pi");
  if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(app.getPath("appData"), "PI-Desktop Personal"));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    if (defaultProfile) process.env.PI_DESKTOP_DATA_DIR = join(homedir(), ".pi-desktop-personal");
    const store = new ContentStore(join(app.getPath("userData"), "content-updates"), config);
    // Synchronous selection preserves Electron's before-ready registration.
    const selected = store.selectForBoot();
    const root = selected ? store.materialize(selected, shellRoot) : shellRoot;
    const version = selected?.version ?? config.version;
    const service = createContentUpdateService(config, store, version);
    globalThis.__PI_CONTENT_SHELL__ = Object.freeze({
      version, shellVersion: config.shellVersion, defaultProfile,
      sidecarPath: selected ? join(root, "agent-runtime", "sidecar.js") : null,
      ...service,
      markHealthy: () => {
        store.markHealthy(version);
        if (process.env.PI_DESKTOP_BOOT_PROBE === "1") console.log("PERSONAL_CONTENT_HEALTHY", version);
      },
    });
    if (selected) app.setAppPath(root);
    // The running version owns its immutable run directory. Never delete a
    // different process's assets or overwrite the signed application bundle.
    app.once("will-quit", () => {
      service.dispose();
      if (selected) fs.rmSync(root, { recursive: true, force: true });
    });
    import(pathToFileURL(join(root, "out", "main", "index.js")).href).catch((error) => {
      console.error("Personal content failed to start; the next launch will use the previous release:", error);
      app.exit(1);
    });
  }
} catch (error) {
  console.error("Personal shell startup failed:", error);
  app.exit(1);
}
