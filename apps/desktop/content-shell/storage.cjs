"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { assertVersion, compareVersions, verifyManifest, isCompatible, validatePayload, MAX_PACKAGE_BYTES } = require("./validation.cjs");

function ensureDirectory(directory) {
  // Refuse links in the managed root and its ancestors before any writes.
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe update directory");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === path.dirname(current)) break;
  }
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function readRegular(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Unsafe update file");
  return fs.readFileSync(file);
}

function atomicJson(file, value) {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

class ContentStore {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    ensureDirectory(root);
    this.stateFile = path.join(root, "state.json");
  }

  readState() {
    if (!fs.existsSync(this.stateFile)) return { schema: 1, active: null, pending: null, trial: null, failed: [] };
    const state = JSON.parse(readRegular(this.stateFile, 16384));
    if (state?.schema !== 1 || !Array.isArray(state.failed) || state.failed.length > 100) throw new Error("Invalid update state");
    for (const version of [state.active, state.pending, state.trial, ...state.failed]) {
      if (version !== null) assertVersion(version);
    }
    return state;
  }

  writeState(state) { atomicJson(this.stateFile, state); }
  versionDir(version) { return path.join(this.root, "versions", assertVersion(version)); }

  readRelease(version) {
    const directory = this.versionDir(version);
    if (!fs.existsSync(directory)) throw new Error("Content release is missing");
    ensureDirectory(directory);
    const bytes = readRegular(path.join(directory, "manifest.json"), 16384);
    const signature = readRegular(path.join(directory, "signature.txt"), 512).toString("utf8");
    const manifest = verifyManifest(bytes, signature, this.config);
    if (manifest.version !== version || !isCompatible(manifest, this.config)) throw new Error("Content requires a different shell");
    const payload = readRegular(path.join(directory, "payload.gz"), MAX_PACKAGE_BYTES);
    return { manifest, files: validatePayload(payload, manifest) };
  }

  stage(bytes, signature, payload) {
    const manifest = verifyManifest(bytes, signature, this.config);
    if (!isCompatible(manifest, this.config)) throw new Error("Content requires a different shell");
    validatePayload(payload, manifest);
    const target = this.versionDir(manifest.version);
    if (fs.existsSync(target)) {
      const existing = this.readRelease(manifest.version);
      if (existing.manifest.sha256 !== manifest.sha256) throw new Error("Published version cannot be replaced");
      return;
    }
    const parent = path.dirname(target);
    ensureDirectory(parent);
    const temporary = fs.mkdtempSync(path.join(parent, ".stage-"));
    try {
      fs.writeFileSync(path.join(temporary, "manifest.json"), bytes, { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(temporary, "signature.txt"), signature, { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(temporary, "payload.gz"), payload, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }

  activate(version, currentVersion) {
    if (compareVersions(version, currentVersion) <= 0) throw new Error("Content update must be newer");
    this.readRelease(version);
    const state = this.readState();
    if (state.failed.includes(version)) throw new Error("This content version previously failed to start");
    this.writeState({ ...state, pending: version });
  }

  selectForBoot() {
    const state = this.readState();
    const failures = [...state.failed];
    if (state.trial) {
      failures.push(state.trial);
      state.pending = null;
    }
    state.trial = null;
    state.failed = [...new Set(failures)].slice(-100);
    let version = state.pending ?? state.active;
    if (version && (compareVersions(version, this.config.version) <= 0 || state.failed.includes(version))) version = null;
    let release = null;
    if (version) {
      try { release = this.readRelease(version); }
      catch (error) {
        console.error("Content boot verification failed; keeping the previous release:", error.message);
        state.failed = [...new Set([...state.failed, version])].slice(-100);
        version = state.active && state.active !== version && compareVersions(state.active, this.config.version) > 0 ? state.active : null;
        if (version) {
          try { release = this.readRelease(version); }
          catch (fallbackError) {
            console.error("Previous content is unavailable; using the embedded release:", fallbackError.message);
            version = null;
          }
        }
      }
    }
    state.pending = null;
    if (version && release) state.trial = version;
    else { state.active = null; version = null; }
    this.writeState(state);
    return version ? { version, files: release.files } : null;
  }

  markHealthy(version) {
    const state = this.readState();
    if (state.trial === version) this.writeState({ ...state, active: version, trial: null });
  }

  materialize(release, shellRoot) {
    const runs = path.join(this.root, "runs");
    ensureDirectory(runs);
    const directory = fs.mkdtempSync(path.join(runs, `${release.version}-`));
    try {
      for (const file of release.files) {
        const output = path.join(directory, file.path);
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        fs.writeFileSync(output, file.data, { flag: "wx", mode: 0o600 });
      }
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "pi-desktop-personal", type: "module", version: release.version }), { mode: 0o600 });
      fs.symlinkSync(path.join(shellRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
      return directory;
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }
}

module.exports = { ContentStore, ensureDirectory, readRegular, atomicJson };
