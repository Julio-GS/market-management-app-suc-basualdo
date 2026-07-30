// ---------------------------------------------------------------------------
// Adapter: Offline IPC handlers
//
// Owns channel constants, exported IPC types, registration/unregistration,
// and result preservation. Delegates all persistence work to OfflineService.
// No DB or fetch logic allowed here.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { OFFLINE_CHANNELS } from "../../../shared/ipc-channels";
import type { OfflineService } from "../../application/offline/offline-service";

export { OFFLINE_CHANNELS };

// Re-export for preload consumers (types + pure helper)
export type {
  OfflineLoginParams,
  OfflineLoginIpcResult,
  OfflineSessionIpcResult,
} from "../../domain/offline/offline";
export { toOfflineSessionIpcResult } from "../../domain/offline/offline";

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerOfflineIpc(offlineService: OfflineService): void {
  // -------------------------------------------------------------------------
  // offline:get-state
  // -------------------------------------------------------------------------
  ipcMain.handle(OFFLINE_CHANNELS.GET_STATE, () => {
    return offlineService.getState();
  });

  // -------------------------------------------------------------------------
  // offline:get-session
  // -------------------------------------------------------------------------
  ipcMain.handle(OFFLINE_CHANNELS.GET_SESSION, () => {
    return offlineService.getSession();
  });

  // -------------------------------------------------------------------------
  // offline:login
  // -------------------------------------------------------------------------
  ipcMain.handle(
    OFFLINE_CHANNELS.LOGIN,
    async (_event, params) => {
      return offlineService.login(params);
    },
  );
}

/**
 * Remove all offline IPC handlers. Call during app shutdown or when
 * tearing down the DB.
 */
export function unregisterOfflineIpc(): void {
  ipcMain.removeHandler(OFFLINE_CHANNELS.GET_STATE);
  ipcMain.removeHandler(OFFLINE_CHANNELS.GET_SESSION);
  ipcMain.removeHandler(OFFLINE_CHANNELS.LOGIN);
}

// ---------------------------------------------------------------------------
// Connectivity check IPC (optional)
// ---------------------------------------------------------------------------

/**
 * Register the manual connectivity-check IPC handler.
 *
 * Accepts a check function so the handler remains decoupled from the
 * concrete checker implementation.
 */
export function registerConnectivityIpc(
  checkFn: () => Promise<{ connectivity: string }>,
): void {
  ipcMain.handle(OFFLINE_CHANNELS.CHECK_CONNECTIVITY, async () => {
    return checkFn();
  });
}

/**
 * Remove the connectivity-check IPC handler.
 */
export function unregisterConnectivityIpc(): void {
  ipcMain.removeHandler(OFFLINE_CHANNELS.CHECK_CONNECTIVITY);
}
