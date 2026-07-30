// ---------------------------------------------------------------------------
// Startup connectivity detection
//
// Performs a lightweight reachability check against the configured API base
// URL before bootstrap and sync operations begin.  Uses /health as the
// primary probe with a fallback to a HEAD/GET on the base URL.
//
// The checker is time-bounded (STARTUP_CONNECTIVITY_TIMEOUT_MS for the
// combined primary + fallback window) so the app never hangs waiting for
// a slow or unreachable backend.
// ---------------------------------------------------------------------------

import {
  fetchWithTimeout,
  STARTUP_CONNECTIVITY_TIMEOUT_MS,
  CONNECTIVITY_RETRY_DELAY_MS,
} from "./fetch-timeout";
import {
  setConnectivityState,
  type ConnectivityState,
} from "./connectivity-state";

// ---------------------------------------------------------------------------
// Single-flight guard
// ---------------------------------------------------------------------------

let _checkInFlight = false;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform a single connectivity check against `apiBaseUrl`.
 *
 * 1. GET `{apiBaseUrl}/health` (primary probe)
 * 2. On 404/405 → HEAD `{apiBaseUrl}` (first fallback)
 * 3. On HEAD 405 → GET `{apiBaseUrl}` (second fallback)
 * 4. Any HTTP response except 404/405 → "online"
 * 5. Transport error / abort / timeout → "offline"
 *
 * The combined primary + fallback window is bounded by `deadlineMs`
 * (default: `STARTUP_CONNECTIVITY_TIMEOUT_MS`).  Each individual fetch
 * uses the same deadline so the overall check does not exceed it.
 *
 * @returns The resolved ConnectivityState ("online" | "offline").
 */
export async function checkConnectivity(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  deadlineMs: number = STARTUP_CONNECTIVITY_TIMEOUT_MS,
): Promise<ConnectivityState> {
  const base = normalizeBaseUrl(apiBaseUrl);
  const deadlineAt = Date.now() + deadlineMs;

  // ---- primary probe: GET /health ----
  try {
    const response = await fetchWithTimeout(
      `${base}/health`,
      {},
      remainingDeadlineMs(deadlineAt),
      fetchImpl,
    );
    // 404 or 405 → fall through to fallback (server is reachable but /health
    // endpoint does not exist).  Any other status (200, 401, 403, 500, …)
    // proves the backend is reachable.
    if (response.status !== 404 && response.status !== 405) {
      return transitionTo("online");
    }
  } catch {
    // Transport error / abort / timeout on the primary probe → offline.
    return transitionTo("offline");
  }

  // ---- first fallback: HEAD {base} ----
  try {
    const response = await fetchWithTimeout(
      base,
      { method: "HEAD" },
      remainingDeadlineMs(deadlineAt),
      fetchImpl,
    );
    // 405 means HEAD is not allowed — fall through to GET fallback.
    // Any other response means the server is reachable.
    if (response.status !== 405) {
      return transitionTo("online");
    }
  } catch {
    // Transport error on fallback → offline.
    return transitionTo("offline");
  }

  // ---- second fallback: GET {base} ----
  try {
    await fetchWithTimeout(base, {}, remainingDeadlineMs(deadlineAt), fetchImpl);
    return transitionTo("online");
  } catch {
    return transitionTo("offline");
  }
}

/**
 * Start the startup connectivity detection sequence.
 *
 * Immediately sets state to "reconnecting", runs the first check, and
 * schedules retries on failure.  This is fire-and-forget — callers
 * observe state transitions via `onConnectivityChange`.
 *
 * If a detection cycle is already in-flight the call is a no-op.
 */
export function startStartupConnectivityDetection(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  if (_checkInFlight) return;

  setConnectivityState("reconnecting");
  _runCheck(apiBaseUrl, fetchImpl);
}

/**
 * Manually trigger a connectivity check (e.g. from the renderer's "Retry" button).
 *
 * Clears any pending automatic retry timer before running.
 *
 * @returns The resolved ConnectivityState.
 */
export async function manualRetryConnectivity(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ConnectivityState> {
  cancelConnectivityDetection();
  setConnectivityState("reconnecting");
  return checkConnectivity(apiBaseUrl, fetchImpl);
}

/**
 * Cancel any pending retry timer.  Does NOT change the current
 * connectivity state.
 */
export function cancelConnectivityDetection(): void {
  if (_retryTimer !== null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _checkInFlight = false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function remainingDeadlineMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function transitionTo(next: ConnectivityState): ConnectivityState {
  setConnectivityState(next);
  return next;
}

async function _runCheck(
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  _checkInFlight = true;
  try {
    const result = await checkConnectivity(apiBaseUrl, fetchImpl);
    if (result === "offline") {
      _scheduleRetry(apiBaseUrl, fetchImpl);
    }
  } catch {
    // Defensive — checkConnectivity should never throw, but if it does,
    // treat as offline and schedule a retry.
    setConnectivityState("offline");
    _scheduleRetry(apiBaseUrl, fetchImpl);
  } finally {
    _checkInFlight = false;
  }
}

function _scheduleRetry(
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
): void {
  // Avoid duplicate timers.
  if (_retryTimer !== null) return;

  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    await _runCheck(apiBaseUrl, fetchImpl);
  }, CONNECTIVITY_RETRY_DELAY_MS);
}
