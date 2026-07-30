import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Dynamic import — the module under test exists now (GREEN phase).
// ---------------------------------------------------------------------------
let connectivityCheckModule: typeof import("./connectivity-check") | null = null;

async function loadConnectivityCheck() {
  if (!connectivityCheckModule) {
    connectivityCheckModule = await import("./connectivity-check");
  }
  return connectivityCheckModule;
}

// We also need connectivity-state for assertions.
import {
  getConnectivityState,
  resetConnectivityState,
  onConnectivityChange,
} from "./connectivity-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch that succeeds with a given status. */
function successFetch(status: number) {
  return vi.fn().mockResolvedValue(new Response("ok", { status }));
}

/** Create a mock fetch that returns 404 for /health and a given status for the root. */
function healthNotFoundFetch(rootStatus: number) {
  return vi.fn().mockImplementation((input: string, init?: RequestInit) => {
    const url = input as string;
    if (url.includes("/health")) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    // For the fallback HEAD request, respect the method
    if (init?.method === "HEAD") {
      return Promise.resolve(new Response("", { status: rootStatus }));
    }
    return Promise.resolve(new Response("ok", { status: rootStatus }));
  });
}

/** Create a mock fetch that rejects with a network error. */
function networkErrorFetch() {
  return vi.fn().mockRejectedValue(new TypeError("fetch failed"));
}

/** Create a mock fetch that hangs until aborted. */
function hangingFetch() {
  return vi.fn().mockImplementation(
    (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkConnectivity", () => {
  beforeEach(async () => {
    resetConnectivityState();
    // Reset connectivity-check module-level state (retry timers, in-flight flags).
    const mod = await loadConnectivityCheck();
    mod.cancelConnectivityDetection();
    vi.useFakeTimers();
    // Delete AbortSignal.timeout so the fallback setTimeout-based path is
    // used, which works with vi.useFakeTimers().
    delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore AbortSignal.timeout — it may not exist in all environments.
    // In Node 24 it exists natively; we just rely on the module being
    // re-imported for each test run.
  });

  // -----------------------------------------------------------------------
  // Quick success
  // -----------------------------------------------------------------------

  describe("quick success", () => {
    it("sets connectivity to 'online' when /health returns 200", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = successFetch(200);

      const promise = mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("online");
      expect(getConnectivityState()).toBe("online");
    });

    it("prefers the primary /health GET request", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      const firstCall = mockFetch.mock.calls[0];
      const firstUrl = typeof firstCall[0] === "string" ? firstCall[0] : (firstCall[0] as Request).url;
      expect(firstUrl).toContain("/health");
    });
  });

  // -----------------------------------------------------------------------
  // Network error → offline
  // -----------------------------------------------------------------------

  describe("network error detection", () => {
    it("sets connectivity to 'offline' when fetch rejects with a network error", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = networkErrorFetch();

      const promise = mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("offline");
      expect(getConnectivityState()).toBe("offline");
    });
  });

  // -----------------------------------------------------------------------
  // Hanging fetch → offline after timeout
  // -----------------------------------------------------------------------

  describe("hanging fetch timeout", () => {
    it("sets connectivity to 'offline' when fetch hangs and the startup deadline elapses", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = hangingFetch();

      const promise = mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      // Advance past the 5-second startup deadline so the setTimeout-based
      // fallback AbortController fires.
      await vi.advanceTimersByTimeAsync(5_500);
      const result = await promise;

      expect(result).toBe("offline");
      expect(getConnectivityState()).toBe("offline");
    });

    it("aborts the fetch when the deadline elapses", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = hangingFetch();

      const promise = mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);
      await vi.advanceTimersByTimeAsync(5_500);

      // The promise should resolve to offline (not throw).
      const result = await promise;
      expect(result).toBe("offline");
    });
  });

  // -----------------------------------------------------------------------
  // Health endpoint fallback
  // -----------------------------------------------------------------------

  describe("health endpoint fallback", () => {
    it("falls back to HEAD base URL when /health returns 404", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = healthNotFoundFetch(200);

      await vi.runAllTimersAsync();
      const result = await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      expect(result).toBe("online");
      expect(getConnectivityState()).toBe("online");

      // Verify the fallback was attempted (GET /health 404 → HEAD /)
          const urls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.map(
            (call: unknown[]) => call[0] as string,
          );
      expect(urls.some((u) => u.includes("/health"))).toBe(true);
      expect(urls.some((u) => !u.includes("/health"))).toBe(true);
    });

    it("falls back to GET base URL when HEAD returns 405", async () => {
      const mod = await loadConnectivityCheck();
      const callOrder: string[] = [];

      const mockFetch = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        const url = input as string;
        const method = init?.method ?? "GET";
        callOrder.push(`${method} ${url}`);

        if (url.includes("/health")) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if (method === "HEAD") {
          return Promise.resolve(new Response("", { status: 405 }));
        }
        return Promise.resolve(new Response("ok", { status: 200 }));
      });

      await vi.runAllTimersAsync();
      const result = await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      expect(result).toBe("online");
      // Should have attempted GET /health (404), HEAD / (405), and GET /
      expect(callOrder.length).toBeGreaterThanOrEqual(2);
    });

    it("uses one shared deadline budget across /health and fallback probes", async () => {
      const mod = await loadConnectivityCheck();
      let settled = false;

      const mockFetch = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        const url = input as string;
        const method = init?.method ?? "GET";

        if (url.includes("/health")) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("not found", { status: 404 })), 40);
          });
        }

        if (method === "HEAD") {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("", { status: 405 })), 40);
          });
        }

        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      });

      const promise = mod
        .checkConnectivity("http://localhost:3000/api/v1", mockFetch, 100)
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(110);

      expect(settled).toBe(true);
      await expect(promise).resolves.toBe("offline");
      expect(getConnectivityState()).toBe("offline");
    });

    it("treats 401/403 fallback response as 'online'", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = healthNotFoundFetch(401);

      await vi.runAllTimersAsync();
      const result = await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      expect(result).toBe("online");
      expect(getConnectivityState()).toBe("online");
    });

    it("treats 403 fallback response as 'online'", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = healthNotFoundFetch(403);

      await vi.runAllTimersAsync();
      const result = await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      expect(result).toBe("online");
    });

    it("treats /health 200 as online without fallback", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await vi.runAllTimersAsync();
      const result = await mod.checkConnectivity("http://localhost:3000/api/v1", mockFetch);

      expect(result).toBe("online");
      // Only one call — no fallback needed.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Normalizes the base URL
  // -----------------------------------------------------------------------

  describe("base URL normalization", () => {
    it("trims trailing slashes from apiBaseUrl", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

      await vi.runAllTimersAsync();
      await mod.checkConnectivity("http://localhost:3000/api/v1/", mockFetch);

      const firstCall = mockFetch.mock.calls[0];
      const firstUrl = typeof firstCall[0] === "string" ? firstCall[0] : (firstCall[0] as Request).url;
      // Should NOT contain double slashes
      expect(firstUrl).not.toContain("//health");
    });
  });

  // -----------------------------------------------------------------------
  // Startup detection lifecycle
  // -----------------------------------------------------------------------

  describe("startStartupConnectivityDetection", () => {
    it("starts detection and updates connectivity state", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = successFetch(200);

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);

      // The function must set state to "reconnecting" at start.
      expect(getConnectivityState()).toBe("reconnecting");

      // Wait for the async check to complete.
      await vi.runAllTimersAsync();

      expect(getConnectivityState()).toBe("online");
    });

    it("does not throw when called (fire-and-forget API)", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = networkErrorFetch();

      // Should not throw — start detection is fire-and-forget.
      expect(() => {
        mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      }).not.toThrow();

      // Let the first check's microtasks flush (mock rejects immediately,
      // so the check resolves synchronously to "offline").
      await vi.advanceTimersByTimeAsync(0);
      expect(getConnectivityState()).toBe("offline");
    });
  });

  // -----------------------------------------------------------------------
  // Retry scheduling
  // -----------------------------------------------------------------------

  describe("retry scheduling", () => {
    it("schedules a retry 15s after a failed check", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = networkErrorFetch();

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      expect(getConnectivityState()).toBe("reconnecting");

      // Let the first check complete (fail → offline).
      await vi.advanceTimersByTimeAsync(0);
      expect(getConnectivityState()).toBe("offline");

      // Advance 15s to trigger the retry. The retry fires, calls checkConnectivity
      // again with the same mock, fails again → stays offline.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);

      // After retry, state should still be offline (original mock failed again).
      // This test just verifies the retry mechanism doesn't throw.
      expect(getConnectivityState()).toBe("offline");
    });

    it("retry succeeds and transitions to 'online'", async () => {
      const mod = await loadConnectivityCheck();

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(new Response("ok", { status: 200 }));
      });

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      // First check completes (mock rejects immediately).
      await vi.advanceTimersByTimeAsync(10);
      expect(getConnectivityState()).toBe("offline");

      // Use runAllTimersAsync — the retry timer fires (at T+15s),
      // the mock succeeds on the second call, state becomes "online",
      // and no further retries are scheduled. Safe to run all timers.
      await vi.runAllTimersAsync();

      expect(getConnectivityState()).toBe("online");
    });
  });

  // -----------------------------------------------------------------------
  // Manual retry
  // -----------------------------------------------------------------------

  describe("manualRetryConnectivity", () => {
    it("runs an immediate check and returns the result", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = successFetch(200);

      // Set initial state to offline.
      resetConnectivityState();

      const promise = mod.manualRetryConnectivity("http://localhost:3000/api/v1", mockFetch);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("online");
      expect(getConnectivityState()).toBe("online");
    });

    it("clears any pending retry timer before running the manual check", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = networkErrorFetch();

      // Start detection → first check fails → retry is scheduled.
      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      // Let the first check's microtask complete (mock rejects immediately).
      await vi.advanceTimersByTimeAsync(0);
      expect(getConnectivityState()).toBe("offline");

      // Cancel and manual retry with a successful fetch.
      const successMock = successFetch(200);
      const promise = mod.manualRetryConnectivity("http://localhost:3000/api/v1", successMock);
      // Let the manual check complete.
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result).toBe("online");
      expect(getConnectivityState()).toBe("online");

      // Advance past the original retry delay — the retry should NOT fire
      // because the timer was cancelled.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(getConnectivityState()).toBe("online");
    });
  });

  // -----------------------------------------------------------------------
  // cancelConnectivityDetection
  // -----------------------------------------------------------------------

  describe("cancelConnectivityDetection", () => {
    it("cancels pending retry timers", async () => {
      const mod = await loadConnectivityCheck();
      const mockFetch = networkErrorFetch();

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      // First check fails immediately (mock rejects).
      await vi.advanceTimersByTimeAsync(0);
      expect(getConnectivityState()).toBe("offline");

      // Cancel before the retry fires.
      mod.cancelConnectivityDetection();

      // Advance past the retry delay — nothing should happen.
      await vi.advanceTimersByTimeAsync(15_000);

      // State should remain offline because the retry was cancelled.
      expect(getConnectivityState()).toBe("offline");
    });
  });

  // -----------------------------------------------------------------------
  // State transitions from the checker
  // -----------------------------------------------------------------------

  describe("state transitions via setConnectivityState", () => {
    it("transitions to 'reconnecting' at the start and 'online' on success", async () => {
      const mod = await loadConnectivityCheck();
      const transitions: string[] = [];

      onConnectivityChange((next) => {
        transitions.push(next);
      });

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", successFetch(200));
      expect(transitions[0]).toBe("reconnecting");

      await vi.runAllTimersAsync();
      expect(transitions).toContain("online");
    });
  });

  // -----------------------------------------------------------------------
  // Single-flight: no duplicate checks
  // -----------------------------------------------------------------------

  describe("single-flight protection", () => {
    it("does not start a second detection if one is already in-flight", async () => {
      const mod = await loadConnectivityCheck();
      let resolveFirst!: (value: Response) => void;
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      );

      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);
      expect(getConnectivityState()).toBe("reconnecting");

      // Calling start again should NOT trigger another fetch.
      mod.startStartupConnectivityDetection("http://localhost:3000/api/v1", mockFetch);

      // Only one fetch should have been made.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Resolve the first check.
      resolveFirst(new Response("ok", { status: 200 }));
      await vi.runAllTimersAsync();
      expect(getConnectivityState()).toBe("online");
    });
  });
});
