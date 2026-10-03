"use strict";

const { MAX_PACKAGE_BYTES, verifyManifest, isCompatible, compareVersions } = require("./validation.cjs");

function allowedDownload(url, repository) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  if (parsed.hostname === "github.com") return parsed.pathname.startsWith(`/${repository}/releases/`);
  return parsed.hostname === "release-assets.githubusercontent.com" || parsed.hostname === "objects.githubusercontent.com";
}

async function fetchBytes(url, { repository, limit, signal, fetchImpl = fetch, progress }) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!allowedDownload(url, repository)) throw new Error("Untrusted update download address");
    const response = await fetchImpl(url, { redirect: "manual", signal, headers: { Accept: "application/octet-stream" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Invalid update redirect");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Update request failed (${response.status})`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body.cancel();
      throw new Error("Update download exceeds size limit");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        count += value.length;
        if (count > limit) throw new Error("Update download exceeds size limit");
        chunks.push(Buffer.from(value));
        progress?.(Math.min(99, (count / limit) * 100));
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel(); }
  }
  throw new Error("Too many update redirects");
}

function createContentUpdateService(config, store, currentVersion, fetchImpl) {
  const abort = new AbortController();
  let release = null;
  let downloaded = null;
  let operation = null;
  const options = (limit, timeout) => ({ repository: config.repository, limit,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]), fetchImpl });
  const assertLive = () => abort.signal.throwIfAborted();
  return {
    async check() {
      assertLive();
      if (operation) return operation;
      const check = async () => {
        const root = `https://github.com/${config.repository}/releases/latest/download`;
        const [bytes, sig] = await Promise.all([
          fetchBytes(`${root}/content-manifest.json`, options(16384, 15000)),
          fetchBytes(`${root}/content-manifest.sig`, options(512, 15000)),
        ]);
        assertLive();
        const signature = sig.toString("utf8");
        const manifest = verifyManifest(bytes, signature, config);
        if (compareVersions(manifest.version, currentVersion) <= 0 || store.readState().failed.includes(manifest.version)) {
          release = null;
          return null;
        }
        release = { bytes, signature, manifest };
        return { version: manifest.version, compatible: isCompatible(manifest, config) };
      };
      operation = check();
      try { return await operation; } finally { operation = null; }
    },
    async download(onProgress) {
      assertLive();
      if (!release || !isCompatible(release.manifest, config)) throw new Error("No compatible content update");
      const selected = release;
      const { manifest } = selected;
      const url = `https://github.com/${config.repository}/releases/download/personal-v${manifest.version}/${manifest.artifact}`;
      const payload = await fetchBytes(url, { ...options(Math.min(MAX_PACKAGE_BYTES, manifest.size), 300000), progress: onProgress });
      assertLive();
      store.stage(selected.bytes, selected.signature, payload);
      downloaded = manifest.version;
      onProgress?.(100);
    },
    activate() {
      assertLive();
      if (!downloaded) throw new Error("No downloaded content update");
      store.activate(downloaded, currentVersion);
    },
    dispose() { abort.abort(); },
  };
}

module.exports = { allowedDownload, fetchBytes, createContentUpdateService };
