import type { AppUpdaterController } from "./updater";

export type UpdaterController = Pick<
  AppUpdaterController,
  | "getState"
  | "refreshReleaseNotes"
  | "check"
  | "download"
  | "install"
  | "openReleases"
  | "startAutoCheck"
  | "dispose"
  | "isInstallingUpdate"
  | "setPreference"
  | "reclaimRelocatedUpdateCache"
>;

export type ContentShellBridge = {
  version: string;
  shellVersion: string;
  sidecarPath: string | null;
  defaultProfile: boolean;
  check(): Promise<{ version: string; compatible: boolean } | null>;
  download(onProgress?: (percent: number) => void): Promise<void>;
  activate(): void;
  markHealthy(): void;
  dispose(): void;
};

export function getContentShellBridge(): ContentShellBridge | null {
  const bridge = (globalThis as typeof globalThis & {
    __PI_CONTENT_SHELL__?: Partial<ContentShellBridge>;
  }).__PI_CONTENT_SHELL__;
  if (bridge === undefined) return null;
  if (
    !bridge ||
    typeof bridge.version !== "string" ||
    typeof bridge.shellVersion !== "string" ||
    !(typeof bridge.sidecarPath === "string" || bridge.sidecarPath === null) ||
    typeof bridge.defaultProfile !== "boolean" ||
    typeof bridge.check !== "function" ||
    typeof bridge.download !== "function" ||
    typeof bridge.activate !== "function" ||
    typeof bridge.markHealthy !== "function" ||
    typeof bridge.dispose !== "function"
  ) throw new Error("Invalid personal content shell bridge");
  return bridge as ContentShellBridge;
}

export function createUpdaterController(input: {
  bridge: ContentShellBridge | null;
  createElectronUpdater: () => AppUpdaterController;
  createContentUpdater: (bridge: ContentShellBridge) => UpdaterController;
}): UpdaterController {
  return input.bridge
    ? input.createContentUpdater(input.bridge)
    : input.createElectronUpdater();
}
