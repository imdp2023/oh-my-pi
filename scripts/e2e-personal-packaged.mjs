#!/usr/bin/env node
// Validate the built personal application itself with an isolated profile and
// the existing real host/preload/renderer BOOT_PROBE. Never launch /Applications.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bundle = resolve(process.argv[2] ?? "apps/desktop/release/mac-arm64/PI-Desktop Personal.app");
const binary = join(bundle, "Contents/MacOS/PI-Desktop Personal");
if (!existsSync(binary)) throw new Error(`Personal packaged executable is missing: ${binary}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-desktop-boot-")));
const env = { ...process.env,
  PI_DESKTOP_DATA_DIR: root,
  PI_DESKTOP_BOOT_PROBE: "1",
  PI_DESKTOP_START_MAXIMIZED: "0",
  ELECTRON_RENDERER_URL: "",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_DESKTOP_DEV;
delete env.PI_DESKTOP_HOST_BIN;
const child = spawn(binary, [`--user-data-dir=${join(root, "profile")}`], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let timedOut = false;
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });
const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const line = output.split("\n").find(line => line.startsWith("BOOT_PROBE "));
  const result = line ? JSON.parse(line.slice("BOOT_PROBE ".length)) : null;
  if (timedOut || code !== 0 || !result?.ok || !output.includes("PERSONAL_CONTENT_HEALTHY ")) {
    throw new Error(`Personal package smoke failed (exit ${code}, timeout ${timedOut}):\n${output.slice(-5000)}`);
  }
  console.log("PASS: packaged personal shell launches its real native host, sandboxed preload and renderer with an isolated profile");
} finally {
  clearTimeout(timer);
  rmSync(root, { force: true, recursive: true });
}
