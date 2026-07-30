// ---------------------------------------------------------------------------
// Adapter: Sync IPC handlers
//
// Owns channel constants, exported IPC types, registration/unregistration,
// backend sync function factories, and legacy handler fallbacks.
// Delegates replay and pull behavior to protected shared sync infrastructure.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { SYNC_CHANNELS } from "../../../shared/ipc-channels";
import {
  getOutboxStatusCounts,
  isRevalidationRequired,
  replayOutbox,
  type ReplayResult,
  type SyncPushFn,
  type RevalidateFn,
  type SyncPushResponse,
} from "../../sync-engine";
import {
  pullAndApply,
  type PullResult,
  type PullResponse,
} from "../../pull-reconciliation";
import type { BusyTracker } from "../../busy-state";
import { setConnectivityState } from "../../connectivity-state";
import { fetchWithTimeout, SYNC_FETCH_TIMEOUT_MS, REVALIDATE_FETCH_TIMEOUT_MS } from "../../fetch-timeout";

export { SYNC_CHANNELS };

export interface SyncStatePayload {
  pendingCount: number;
  failedCount: number;
  inFlightCount: number;
  retryWaitCount: number;
  blockedAuthCount: number;
  blockedConflictCount: number;
  manualFixCount: number;
  revalidationRequired: boolean;
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Pull function factory
// ---------------------------------------------------------------------------

function createBackendPullFn(
  apiBaseUrl: string,
  token: string,
): (cursor?: string) => Promise<PullResponse> {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/sync/pull`;

  return async (cursor?: string): Promise<PullResponse> => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);

    const fetchUrl = `${url}?${params.toString()}`;

    try {
      const response = await fetchWithTimeout(
        fetchUrl,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        SYNC_FETCH_TIMEOUT_MS,
      );

      if (!response.ok) {
        const details = await readResponseDetails(response);
        setConnectivityState("offline");
        throw new Error(buildBackendErrorMessage("Pull request failed", response, details));
      }

      setConnectivityState("online");
      return (await response.json()) as PullResponse;
    } catch (error) {
      setConnectivityState("offline");
      throw wrapFetchError("Pull request failed", error);
    }
  };
}

// ---------------------------------------------------------------------------
// Push function factory
// ---------------------------------------------------------------------------

export function createBackendPushFn(
  apiBaseUrl: string,
  token: string,
): SyncPushFn {
  const base = apiBaseUrl.replace(/\/+$/, "");

  return async (entries) => {
    try {
      const response = await fetchWithTimeout(
        `${base}/sync/push`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entries: entries.map((e) => ({
              id: e.id,
              idempotency_key: e.idempotency_key,
              operation_type: e.operation_type,
              aggregate_type: e.aggregate_type,
              aggregate_id: e.aggregate_id,
              payload: JSON.parse(e.payload),
              base_server_version: e.base_server_version,
              actor_user_id: e.actor_user_id,
              created_at: e.created_at,
            })),
          }),
        },
        SYNC_FETCH_TIMEOUT_MS,
      );

      if (!response.ok) {
        const details = await readResponseDetails(response);
        setConnectivityState("offline");
        throw new Error(buildBackendErrorMessage("Push request failed", response, details));
      }

      setConnectivityState("online");
      return (await response.json()) as SyncPushResponse;
    } catch (error) {
      setConnectivityState("offline");
      throw wrapFetchError("Push request failed", error);
    }
  };
}

export function createBackendRevalidateFn(
  apiBaseUrl: string,
  token: string,
): RevalidateFn {
  const base = apiBaseUrl.replace(/\/+$/, "");

  return async (userId) => {
    try {
      const response = await fetchWithTimeout(
        `${base}/auth/revalidate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_id: userId }),
        },
        REVALIDATE_FETCH_TIMEOUT_MS,
      );

      if (!response.ok) {
        const details = await readResponseDetails(response);
        return {
          valid: false,
          user_id: userId,
          reason: buildBackendErrorMessage("Revalidation failed", response, details),
        };
      }

      setConnectivityState("online");
      return (await response.json()) as {
        valid: boolean;
        user_id: string;
        username?: string;
        reason?: string;
      };
    } catch (error) {
      setConnectivityState("offline");
      return {
        valid: false,
        user_id: userId,
        reason: wrapFetchError("Revalidation failed", error).message,
      };
    }
  };
}

async function readResponseDetails(response: Response): Promise<string | null> {
  const body = await response.text();
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildBackendErrorMessage(
  prefix: string,
  response: Response,
  details?: string | null,
): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return details
    ? `${prefix}: ${response.status}${statusText} - ${details}`
    : `${prefix}: ${response.status}${statusText}`;
}

function wrapFetchError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.startsWith(`${prefix}:`)) {
      return error;
    }
    return new Error(`${prefix}: ${error.message}`);
  }
  return new Error(`${prefix}: Unknown error`);
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerSyncIpc(
  getDb: () => Database.Database,
  onSyncAuth?: (params: { apiBaseUrl: string; token: string }) => void,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(SYNC_CHANNELS.GET_SYNC_STATE, (): SyncStatePayload => {
    try {
      const db = getDb();
      const lastSyncRow = db
        .prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'")
        .get() as { value: string } | undefined;

      const counts = getOutboxStatusCounts(db);

      return {
        pendingCount: counts.pending,
        failedCount: counts.failed,
        inFlightCount: counts.in_flight,
        retryWaitCount: counts.retry_wait,
        blockedAuthCount: counts.blocked_auth,
        blockedConflictCount: counts.blocked_conflict,
        manualFixCount: counts.manual_fix,
        revalidationRequired: isRevalidationRequired(db),
        lastSyncAt: lastSyncRow?.value || null,
      };
    } catch {
      return {
        pendingCount: 0,
        failedCount: 0,
        inFlightCount: 0,
        retryWaitCount: 0,
        blockedAuthCount: 0,
        blockedConflictCount: 0,
        manualFixCount: 0,
        revalidationRequired: false,
        lastSyncAt: null,
      };
    }
  });

  ipcMain.handle(
    SYNC_CHANNELS.START_SYNC,
    async (
      _event,
      params?: { apiBaseUrl?: string; token?: string },
    ): Promise<ReplayResult> => {
      const run = async () => {
        try {
          const db = getDb();

          let pushResult: ReplayResult = {
            synced: 0,
            failed: 0,
            blocked: 0,
            skipped: 0,
            revalidationBlocked: false,
          };

          if (params?.apiBaseUrl && params?.token) {
            onSyncAuth?.({ apiBaseUrl: params.apiBaseUrl, token: params.token });

            const pushFn = createBackendPushFn(params.apiBaseUrl, params.token);
            const revalidateFn = createBackendRevalidateFn(params.apiBaseUrl, params.token);

            pushResult = await replayOutbox(db, pushFn, revalidateFn);

            if (!pushResult.revalidationBlocked && pushResult.blocked === 0) {
              const pullFn = createBackendPullFn(params.apiBaseUrl, params.token);
              await pullAndApply(db, pullFn);
            }
          }

          return pushResult;
        } catch {
          return {
            synced: 0,
            failed: 0,
            blocked: 0,
            skipped: 0,
            revalidationBlocked: false,
          };
        }
      };

      return busyTracker?.runProtectedOperation("sync", "Start sync", run) ?? run();
    },
  );

  ipcMain.handle(
    SYNC_CHANNELS.PULL,
    async (
      _event,
      params?: { apiBaseUrl?: string; token?: string },
    ): Promise<PullResult> => {
      const run = async () => {
        try {
          const db = getDb();

          if (!params?.apiBaseUrl || !params?.token) {
            return {
              applied: 0,
              skipped: 0,
              cursor: null,
              hasMore: false,
            };
          }

          const pullFn = createBackendPullFn(params.apiBaseUrl, params.token);
          return await pullAndApply(db, pullFn);
        } catch {
          return {
            applied: 0,
            skipped: 0,
            cursor: null,
            hasMore: false,
          };
        }
      };

      return busyTracker?.runProtectedOperation("sync", "Pull changes", run) ?? run();
    },
  );
}

export function unregisterSyncIpc(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.START_SYNC);
  ipcMain.removeHandler(SYNC_CHANNELS.GET_SYNC_STATE);
  ipcMain.removeHandler(SYNC_CHANNELS.PULL);
}
