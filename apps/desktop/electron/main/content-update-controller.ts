import { IPC, type UpdatePreference, type UpdateState } from "@pi-desktop/shared";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { Logger } from "./logger";
import type { ContentShellBridge, UpdaterController } from "./updater-factory";
import { parseAllowedExternalUrl } from "./safe-open-external";

const RELEASES_URL = "https://github.com/imdp2023/oh-my-pi/releases/latest";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ContentUpdateOptions = {
  bridge: ContentShellBridge;
  logger: Logger;
  send: (channel: string, payload: unknown) => void;
  getBusyReason: () => string | null;
  getLocale: () => string;
  readUpdatePreference?: () => Promise<unknown>;
  showNativeMessage: (input: { title: string; message: string; buttons: string[] }) => Promise<number>;
  relaunchAndQuit: (args: string[]) => void;
  openExternal: (url: string) => Promise<void>;
};

export class ContentUpdateController implements UpdaterController {
  private readonly bridge: ContentShellBridge;
  private readonly logger: Logger;
  private readonly send: ContentUpdateOptions["send"];
  private readonly getBusyReason: () => string | null;
  private readonly getLocale: () => string;
  private state: UpdateState;
  private disposed = false;
  private checking: Promise<UpdateState> | null = null;
  private downloading: Promise<UpdateState> | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private autoCheckStarted = false;
  private preference: UpdatePreference = "automatic";
  private preferenceRevision = 0;
  private settingsReady: Promise<void> | null = null;
  private readonly readUpdatePreference?: () => Promise<unknown>;
  private readonly showNativeMessage: ContentUpdateOptions["showNativeMessage"];
  private readonly relaunchAndQuit: ContentUpdateOptions["relaunchAndQuit"];
  private readonly openExternal: ContentUpdateOptions["openExternal"];
  private installRequested = false;
  private incompatibleShellUpdate = false;

  constructor(options: ContentUpdateOptions) {
    this.bridge = options.bridge;
    this.logger = options.logger;
    this.send = options.send;
    this.getBusyReason = options.getBusyReason;
    this.getLocale = options.getLocale;
    this.readUpdatePreference = options.readUpdatePreference;
    this.showNativeMessage = options.showNativeMessage;
    this.relaunchAndQuit = options.relaunchAndQuit;
    this.openExternal = options.openExternal;
    this.state = {
      mode: "in-app",
      preference: this.preference,
      defaultPreference: "automatic",
      automaticSupported: true,
      status: "idle",
      currentVersion: this.bridge.version,
      releasesUrl: RELEASES_URL,
    };
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    if (this.disposed) return this.state;
    this.state = { ...this.state, ...patch, preference: this.preference };
    this.send(IPC.event.updatesState, this.state);
    return this.state;
  }

  getState(): UpdateState { return this.state; }
  refreshReleaseNotes(): UpdateState { return this.state; }

  private ensureSettingsLoaded(): Promise<void> {
    if (this.settingsReady) return this.settingsReady;
    const revision = this.preferenceRevision;
    this.settingsReady = (async () => {
      try {
        const value = await this.readUpdatePreference?.();
        if (!this.disposed && revision === this.preferenceRevision && (value === "automatic" || value === "manual")) {
          this.preference = value;
          this.setState({ preference: value });
        }
      } catch (error) {
        if (!this.disposed) {
          this.logger.app("updater", "warn", "personal update preference unavailable", {
            data: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return this.settingsReady;
  }

  async check(options: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.disposed) return this.state;
    await this.ensureSettingsLoaded();
    if (this.disposed) return this.state;
    if (this.checking) return this.checking;
    if (this.downloading || this.state.status === "downloaded") return this.state;
    const operation = (async () => {
      this.setState({ status: "checking", error: undefined, manual: Boolean(options.manual) });
      try {
        const result = await this.bridge.check();
        if (this.disposed) return this.state;
        if (!result) {
          return this.setState({ status: "up-to-date", availableVersion: undefined, progressPercent: undefined });
        }
        if (!result.compatible) {
          this.incompatibleShellUpdate = true;
          const state = this.setState({
            status: "available",
            mode: "manual",
            availableVersion: result.version,
            progressPercent: undefined,
            manualReminder: true,
            error: undefined,
          });
          if (options.manual) this.showIncompatibleShellNotice();
          return state;
        }
        this.incompatibleShellUpdate = false;
        this.setState({ mode: "in-app", status: "available", availableVersion: result.version, progressPercent: undefined, error: undefined });
        if (this.preference === "automatic") return await this.download();
        return this.state;
      } catch (error) {
        if (this.disposed) return this.state;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.app("updater", "warn", "personal content update check failed", { data: message });
        return this.setState({ status: "error", error: message });
      } finally {
        this.checking = null;
      }
    })();
    this.checking = operation;
    return operation;
  }

  private showIncompatibleShellNotice(): void {
    const copy = catalogs[resolveLocale(this.getLocale())];
    void this.showNativeMessage({
      title: copy.updates.incompatibleShellTitle,
      message: copy.updates.incompatibleShell,
      buttons: [copy.updates.viewRelease, copy.common.close],
    }).then((response) => {
      if (response === 0) return this.openReleases();
      return undefined;
    }).catch((error: unknown) => {
      this.logger.app("updater", "warn", "could not show shell update notice", {
        data: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async download(): Promise<UpdateState> {
    if (this.disposed) return this.state;
    if (this.downloading) return this.downloading;
    if (!this.state.availableVersion || this.state.status === "downloaded" || this.incompatibleShellUpdate) return this.state;
    const version = this.state.availableVersion;
    const operation = (async () => {
      this.setState({ status: "downloading", progressPercent: 0, error: undefined });
      try {
        await this.bridge.download((percent) => {
          if (this.disposed || !Number.isFinite(percent)) return;
          this.setState({ status: "downloading", progressPercent: Math.max(0, Math.min(100, Math.round(percent))) });
        });
        if (this.disposed) return this.state;
        return this.setState({ status: "downloaded", availableVersion: version, progressPercent: 100 });
      } catch (error) {
        if (this.disposed) return this.state;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.app("updater", "warn", "personal content update download failed", { data: message });
        return this.setState({ status: "error", availableVersion: version, error: message, progressPercent: undefined });
      } finally {
        this.downloading = null;
      }
    })();
    this.downloading = operation;
    return operation;
  }

  install(): void {
    if (this.disposed || this.state.status !== "downloaded") throw new Error("no downloaded update to install");
    if (this.installRequested) return;
    const busyReason = this.getBusyReason();
    if (busyReason) {
      const copy = catalogs[resolveLocale(this.getLocale())];
      void this.showNativeMessage({
        title: copy.updates.installBusyTitle,
        message: copy.updates.installBusy,
        buttons: [copy.common.close],
      }).catch((error: unknown) => {
        this.logger.app("updater", "warn", "could not show update busy dialog", {
          data: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    try {
      if (this.getBusyReason()) return;
      this.bridge.activate();
      this.installRequested = true;
      const args = process.argv.slice(1);
      if (this.bridge.defaultProfile && !args.includes("--pi-managed-storage")) {
        args.push("--pi-managed-storage");
      }
      this.relaunchAndQuit(args);
    } catch (error) {
      this.installRequested = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.app("updater", "error", "personal content update activation failed", { data: message });
      this.setState({ status: "downloaded", error: message });
    }
  }

  isInstallingUpdate(): boolean { return this.installRequested; }
  setPreference(preference: UpdatePreference): void {
    if (preference !== "automatic" && preference !== "manual") return;
    this.preferenceRevision += 1;
    this.preference = preference;
    this.setState({ preference });
  }
  reclaimRelocatedUpdateCache(): Promise<void> { return Promise.resolve(); }
  async openReleases(): Promise<void> {
    const url = parseAllowedExternalUrl(RELEASES_URL);
    if (!url) throw new Error("DISALLOWED_EXTERNAL_URL");
    await this.openExternal(url);
  }
  startAutoCheck(): void {
    if (this.disposed || this.autoCheckStarted) return;
    this.autoCheckStarted = true;
    this.initialTimer = setTimeout(() => { void this.check().catch(() => undefined); }, AUTO_CHECK_INITIAL_DELAY_MS);
    this.intervalTimer = setInterval(() => { void this.check().catch(() => undefined); }, AUTO_CHECK_INTERVAL_MS);
  }
  markHealthy(): void {
    if (!this.disposed) this.bridge.markHealthy();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.bridge.dispose();
  }
}
