import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import { applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { getContentShellBridge } from "./updater-factory";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
app.setName(APP_NAME);
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const contentShell = getContentShellBridge();
// The fixed launcher owns the lock; managed storage restarts keep its selected
// personal data root instead of reverting to the standard profile.
if (!contentShell && process.argv.includes("--pi-managed-storage")) {
  delete process.env.PI_DESKTOP_DATA_DIR;
}
export const singleInstanceRequired = contentShell
  ? contentShell.defaultProfile
  : !process.env.PI_DESKTOP_DATA_DIR;
export const hasSingleInstanceLock = contentShell
  ? true
  : singleInstanceRequired
    ? app.requestSingleInstanceLock()
    : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
