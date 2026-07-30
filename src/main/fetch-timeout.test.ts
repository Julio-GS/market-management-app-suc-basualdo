import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Dynamic import — the module under test does NOT exist yet (RED phase).
// The import will fail until src/main/fetch-timeout.ts is created.
// ---------------------------------------------------------------------------
let fetchTimeoutModule: typeof import("./fetch-timeout") | null = null;

async function loadFetchTimeout() {
  if (!fetchTimeoutModule) {
    fetchTimeoutModule = await import("./fetch-timeout");
  }
  return fetchTimeoutModule;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response that resolves after `delayMs`. */
function delayedResponse(
  body: string,
  status: number,
  delayMs: number,
): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(new Response(body, { status }));
    }, delayMs);
  });
}

/** Create a mock Response that never resolves until the signal aborts. */
function hangingResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchWithTimeout (RED — module not yet created)", () => {
  let originalAbortSignalTimeout: typeof AbortSignal.timeout | undefined;

  beforeEach(() => {
    // Preserve the native binding so we can test the fallback path.
    originalAbortSignalTimeout = AbortSignal.timeout;
  });

  afterEach(() => {
    // Restore the native binding after every test.
    if (originalAbortSignalTimeout !== undefined) {
      (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout =
        originalAbortSignalTimeout;
    }
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // signal injection
  // -----------------------------------------------------------------------

  describe("signal injection", () => {
    it("passes a signal to the underlying fetch call", async () => {
      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await mod.fetchWithTimeout("http://example.com/api/health", {}, 5000, mockFetch);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe("http://example.com/api/health");
      // The second argument must include a signal
      expect(callArgs[1]).toBeDefined();
      expect(callArgs[1].signal).toBeDefined();
      expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
    });

    it("respects an existing signal passed by the caller", async () => {
      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      const controller = new AbortController();

      await mod.fetchWithTimeout(
        "http://example.com/api/health",
        { signal: controller.signal },
        5000,
        mockFetch,
      );

      const callArgs = mockFetch.mock.calls[0];
      // The caller-supplied signal should be preserved, not replaced.
      expect(callArgs[1].signal).toBe(controller.signal);
    });
  });

  // -----------------------------------------------------------------------
  // native AbortSignal.timeout path
  // -----------------------------------------------------------------------

  describe("native AbortSignal.timeout path", () => {
    it("uses AbortSignal.timeout() when available", async () => {
      // Ensure AbortSignal.timeout is available for this test.
      if (typeof AbortSignal.timeout !== "function") {
        // Environment doesn't support AbortSignal.timeout — still verify
        // the function doesn't throw.
        const mod = await loadFetchTimeout();
        const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
        await expect(
          mod.fetchWithTimeout("http://example.com/api/health", {}, 5000, mockFetch),
        ).resolves.toBeDefined();
        return;
      }

      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await mod.fetchWithTimeout("http://example.com/api/health", {}, 5000, mockFetch);

      const signalPassed = mockFetch.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
      expect(signalPassed).toBeDefined();
      // The signal should have been created via AbortSignal.timeout (it exists,
      // so the utility must prefer it).
      expect(signalPassed?.aborted).toBe(false);
    });

    it("aborts the fetch when the timeout elapses (native)", async () => {
      const mod = await loadFetchTimeout();

      // A mock that simulates a long-running request that respects abort.
      const mockFetch = vi.fn().mockImplementation(
        (_input: string, init?: RequestInit) =>
          hangingResponse(init?.signal ?? new AbortController().signal),
      );

      const promise = mod.fetchWithTimeout(
        "http://example.com/api/health",
        {},
        100, // short timeout
        mockFetch,
      );

      await expect(promise).rejects.toThrow();
      // The error should contain "Abort" somewhere (either DOMException or
      // generic timeout error).
      try {
        await promise;
      } catch (err) {
        expect(String(err)).toMatch(/abort|timeout/i);
      }
    });
  });

  // -----------------------------------------------------------------------
  // fallback path — AbortController + setTimeout
  // -----------------------------------------------------------------------

  describe("fallback path (AbortController + setTimeout)", () => {
    it("falls back to AbortController + setTimeout when AbortSignal.timeout is unavailable", async () => {
      // Temporarily remove AbortSignal.timeout
      delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;

      const mod = await loadFetchTimeout();
      // Clear the module so it re-evaluates the capability check
      // (We need to reload the module after removing AbortSignal.timeout)
      // Since the module uses dynamic import, we can invalidate the module cache.
      vi.resetModules();
      const freshMod = await import("./fetch-timeout");

      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await freshMod.fetchWithTimeout("http://example.com/api/health", {}, 5000, mockFetch);

      const signalPassed = mockFetch.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
      expect(signalPassed).toBeDefined();
      // The fallback controller is not AbortSignal.timeout — the signal
      // should still be functional.
      expect(signalPassed).toBeInstanceOf(AbortSignal);
    });

    it("aborts via fallback after the timeout elapses", async () => {
      // Temporarily remove AbortSignal.timeout
      delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
      vi.resetModules();
      const freshMod = await import("./fetch-timeout");

      const mockFetch = vi.fn().mockImplementation(
        (_input: string, init?: RequestInit) =>
          hangingResponse(init?.signal ?? new AbortController().signal),
      );

      const promise = freshMod.fetchWithTimeout(
        "http://example.com/api/health",
        {},
        100,
        mockFetch,
      );

      await expect(promise).rejects.toThrow();
      try {
        await promise;
      } catch (err) {
        expect(String(err)).toMatch(/abort|timeout/i);
      }
    });

    it("clears the fallback timer after fetch settles (no leak)", async () => {
      delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
      vi.resetModules();
      const freshMod = await import("./fetch-timeout");

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await freshMod.fetchWithTimeout("http://example.com/api/health", {}, 5000, mockFetch);

      // After the fetch resolves, the fallback timer must be cleared.
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // success path
  // -----------------------------------------------------------------------

  describe("success path", () => {
    it("returns the Response on success", async () => {
      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      const response = await mod.fetchWithTimeout(
        "http://example.com/api/health",
        {},
        5000,
        mockFetch,
      );

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });

    it("returns the Response even when the backend returns 401/403", async () => {
      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));

      const response = await mod.fetchWithTimeout(
        "http://example.com/api/health",
        {},
        5000,
        mockFetch,
      );

      expect(response.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // default timeout
  // -----------------------------------------------------------------------

  describe("default timeout", () => {
    it("applies a default timeout when timeoutMs is not provided", async () => {
      const mod = await loadFetchTimeout();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await mod.fetchWithTimeout("http://example.com/api/health", {}, undefined, mockFetch);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].signal).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // timeout constants
  // -----------------------------------------------------------------------

  describe("timeout constants", () => {
    it("exports STARTUP_CONNECTIVITY_TIMEOUT_MS = 5_000", async () => {
      const mod = await loadFetchTimeout();
      expect(mod.STARTUP_CONNECTIVITY_TIMEOUT_MS).toBe(5_000);
    });

    it("exports CONNECTIVITY_RETRY_DELAY_MS = 15_000", async () => {
      const mod = await loadFetchTimeout();
      expect(mod.CONNECTIVITY_RETRY_DELAY_MS).toBe(15_000);
    });

    it("exports BOOTSTRAP_FETCH_TIMEOUT_MS = 15_000", async () => {
      const mod = await loadFetchTimeout();
      expect(mod.BOOTSTRAP_FETCH_TIMEOUT_MS).toBe(15_000);
    });

    it("exports SYNC_FETCH_TIMEOUT_MS = 15_000", async () => {
      const mod = await loadFetchTimeout();
      expect(mod.SYNC_FETCH_TIMEOUT_MS).toBe(15_000);
    });

    it("exports REVALIDATE_FETCH_TIMEOUT_MS = 10_000", async () => {
      const mod = await loadFetchTimeout();
      expect(mod.REVALIDATE_FETCH_TIMEOUT_MS).toBe(10_000);
    });
  });
});
