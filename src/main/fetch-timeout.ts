// ---------------------------------------------------------------------------
// Bounded fetch utility — timeout constants and fetchWithTimeout wrapper.
//
// Every startup/bootstrap/sync/revalidate fetch in the desktop main process
// MUST use an explicit timeout.  This module provides the shared utility so
// no fetch call relies on OS-level TCP timeout behaviour.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeout constants (ms)
// ---------------------------------------------------------------------------

/** Maximum time for the startup connectivity check (primary + fallback). */
export const STARTUP_CONNECTIVITY_TIMEOUT_MS = 5_000;

/** Delay between automatic retry attempts after a failed connectivity check. */
export const CONNECTIVITY_RETRY_DELAY_MS = 15_000;

/** Maximum time for the /sync/bootstrap fetch. */
export const BOOTSTRAP_FETCH_TIMEOUT_MS = 15_000;

/** Maximum time for /sync/push and /sync/pull fetches. */
export const SYNC_FETCH_TIMEOUT_MS = 15_000;

/** Maximum time for the /auth/revalidate fetch. */
export const REVALIDATE_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

/**
 * Call `fetch` with an explicit abort timeout.
 *
 * When `AbortSignal.timeout()` is available (Node ≥ 17.3 / Electron ≥ 21)
 * it is preferred.  Otherwise a manual `AbortController + setTimeout`
 * fallback is used and the timer is cleared after the fetch settles.
 *
 * @param input    Fetch URL or Request.
 * @param init     Standard RequestInit.  A `signal` property, if supplied by
 *                 the caller, is preserved and NOT replaced.
 * @param timeoutMs Abort timeout in milliseconds.  Defaults to
 *                 `STARTUP_CONNECTIVITY_TIMEOUT_MS`.
 * @param fetchImpl Injectable fetch implementation (default: global `fetch`).
 */
export async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = STARTUP_CONNECTIVITY_TIMEOUT_MS,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  // Respect an existing signal passed by the caller.
  if (init?.signal) {
    return fetchImpl(input, init);
  }

  // Prefer the native AbortSignal.timeout when available.
  if (typeof AbortSignal.timeout === "function") {
    const signal = AbortSignal.timeout(timeoutMs);
    return fetchImpl(input, { ...init, signal });
  }

  // Fallback — manual AbortController + setTimeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
