import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Electron
// ---------------------------------------------------------------------------

const { mockIpcMain } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    mockIpcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: mockIpcMain,
}));

// ---------------------------------------------------------------------------
// Imports — some will fail (RED) until production modules exist
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import {
  OFFLINE_CHANNELS,
  registerOfflineIpc,
  unregisterOfflineIpc,
} from "./offline-ipc";
import type { OfflineService } from "../../application/offline/offline-service";

// ---------------------------------------------------------------------------
// Mock OfflineService
// ---------------------------------------------------------------------------

function mockOfflineService(overrides?: Partial<OfflineService>): OfflineService {
  return {
    getState: vi.fn().mockReturnValue({
      ready: true,
      bootstrap: "complete",
      connectivity: "online",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: {
        pending: 0,
        in_flight: 0,
        failed: 0,
        retry_wait: 0,
        blocked_auth: 0,
        blocked_conflict: 0,
        manual_fix: 0,
        synced: 0,
      },
    }),
    getSession: vi.fn().mockReturnValue({
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    }),
    login: vi.fn().mockResolvedValue({
      success: true,
      userId: "user-1",
      username: "cashier1",
      token: "mock-token",
      offlineMode: false,
    }),
    ...overrides,
  } as unknown as OfflineService;
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as {
    _handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

describe("OFFLINE_CHANNELS", () => {
  it("exports byte-identical channel names", () => {
    expect(OFFLINE_CHANNELS.GET_STATE).toBe("offline:get-state");
    expect(OFFLINE_CHANNELS.GET_SESSION).toBe("offline:get-session");
    expect(OFFLINE_CHANNELS.LOGIN).toBe("offline:login");
    // RED: CHECK_CONNECTIVITY does not exist yet — this will fail until the channel is added.
    expect(OFFLINE_CHANNELS.CHECK_CONNECTIVITY).toBe("offline:connectivity:check");
  });

  it("is readonly (as const)", () => {
    // RED: CHECK_CONNECTIVITY does not exist yet — this will fail until the channel is added.
    expect(Object.keys(OFFLINE_CHANNELS)).toHaveLength(4);
    expect(OFFLINE_CHANNELS).toHaveProperty("GET_STATE");
    expect(OFFLINE_CHANNELS).toHaveProperty("GET_SESSION");
    expect(OFFLINE_CHANNELS).toHaveProperty("LOGIN");
    expect(OFFLINE_CHANNELS).toHaveProperty("CHECK_CONNECTIVITY");
  });
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("registerOfflineIpc", () => {
  let service: ReturnType<typeof mockOfflineService>;

  beforeEach(() => {
    service = mockOfflineService();
    vi.clearAllMocks();
    mockIpcMain._handlers.clear();
  });

  afterEach(() => {
    try {
      unregisterOfflineIpc();
    } catch {
      // already removed
    }
  });

  it("registers handler for offline:get-state", () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.GET_STATE);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
    expect(mockIpcMain.handle).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.GET_STATE,
      expect.any(Function),
    );
  });

  it("registers handler for offline:get-session", () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.GET_SESSION);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
    expect(mockIpcMain.handle).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.GET_SESSION,
      expect.any(Function),
    );
  });

  it("registers handler for offline:login", () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.LOGIN);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
    expect(mockIpcMain.handle).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.LOGIN,
      expect.any(Function),
    );
  });

  it("get-state handler delegates to service.getState()", () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.GET_STATE);
    const result = handler();

    expect(service.getState).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ready: true,
      bootstrap: "complete",
      connectivity: "online",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: {
        pending: 0,
        in_flight: 0,
        failed: 0,
        retry_wait: 0,
        blocked_auth: 0,
        blocked_conflict: 0,
        manual_fix: 0,
        synced: 0,
      },
    });
  });

  it("get-session handler delegates to service.getSession()", () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.GET_SESSION);
    const result = handler();

    expect(service.getSession).toHaveBeenCalledOnce();
    expect(result).toEqual({
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("get-session handler returns null when service returns null", () => {
    const nullService = mockOfflineService({
      getSession: vi.fn().mockReturnValue(null),
    });
    registerOfflineIpc(nullService);

    const handler = getHandler(OFFLINE_CHANNELS.GET_SESSION);
    const result = handler();

    expect(result).toBeNull();
  });

  it("login handler delegates to service.login() with params", async () => {
    registerOfflineIpc(service);

    const handler = getHandler(OFFLINE_CHANNELS.LOGIN);
    const params = {
      username: "admin",
      password: "test123",
      apiBaseUrl: "http://localhost:3000/api/v1",
    };

    const result = await handler(null, params);

    expect(service.login).toHaveBeenCalledWith(params);
    expect(result).toEqual({
      success: true,
      userId: "user-1",
      username: "cashier1",
      token: "mock-token",
      offlineMode: false,
    });
  });

  it("login handler passes through error results from service", async () => {
    const errorService = mockOfflineService({
      login: vi.fn().mockResolvedValue({
        success: false,
        error: "Invalid credentials",
      }),
    });
    registerOfflineIpc(errorService);

    const handler = getHandler(OFFLINE_CHANNELS.LOGIN);
    const result = await handler(null, {
      username: "admin",
      password: "wrong",
      apiBaseUrl: "http://localhost:3000/api/v1",
    });

    expect(result).toEqual({
      success: false,
      error: "Invalid credentials",
    });
  });
});

// ---------------------------------------------------------------------------
// Handler unregistration
// ---------------------------------------------------------------------------

describe("unregisterOfflineIpc", () => {
  let service: ReturnType<typeof mockOfflineService>;

  beforeEach(() => {
    service = mockOfflineService();
    vi.clearAllMocks();
    mockIpcMain._handlers.clear();
    registerOfflineIpc(service);
  });

  it("removes all handlers", () => {
    expect(getHandler(OFFLINE_CHANNELS.GET_STATE)).toBeDefined();
    expect(getHandler(OFFLINE_CHANNELS.GET_SESSION)).toBeDefined();
    expect(getHandler(OFFLINE_CHANNELS.LOGIN)).toBeDefined();

    unregisterOfflineIpc();

    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.GET_STATE,
    );
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.GET_SESSION,
    );
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.LOGIN,
    );
    expect(mockIpcMain._handlers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Connectivity check IPC (RED — registerConnectivityIpc does not exist yet)
// ---------------------------------------------------------------------------

describe("registerConnectivityIpc (RED — function not yet created)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcMain._handlers.clear();
  });

  afterEach(() => {
    try {
      // Dynamic import — unregister may not exist yet in RED phase.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./offline-ipc") as typeof import("./offline-ipc");
      if (typeof (mod as Record<string, unknown>).unregisterConnectivityIpc === "function") {
        (mod as unknown as { unregisterConnectivityIpc: () => void }).unregisterConnectivityIpc();
      }
    } catch {
      // Best effort.
    }
  });

  it("CHECK_CONNECTIVITY channel name is 'offline:connectivity:check'", () => {
    expect(OFFLINE_CHANNELS.CHECK_CONNECTIVITY).toBe("offline:connectivity:check");
  });

  it("registerConnectivityIpc registers a handler for offline:connectivity:check", async () => {
    // Dynamic import — the function won't exist yet in RED phase.
    const mod = await import("./offline-ipc");

    // In RED phase, registerConnectivityIpc may not exist.
    if (typeof (mod as Record<string, unknown>).registerConnectivityIpc !== "function") {
      // Expected RED failure — the function doesn't exist yet.
      expect((mod as Record<string, unknown>).registerConnectivityIpc).toBeDefined();
      return;
    }

    const { registerConnectivityIpc } = mod as unknown as {
      registerConnectivityIpc: (checkFn: (params: { apiBaseUrl: string }) => Promise<unknown>) => void;
    };

    const mockCheckFn = vi.fn().mockResolvedValue({ connectivity: "online" });
    registerConnectivityIpc(mockCheckFn);

    expect(mockIpcMain.handle).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.CHECK_CONNECTIVITY,
      expect.any(Function),
    );

    const handler = getHandler(OFFLINE_CHANNELS.CHECK_CONNECTIVITY);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
  });

  it("check-connectivity handler delegates to the provided check function without renderer params", async () => {
    const mod = await import("./offline-ipc");
    if (typeof (mod as Record<string, unknown>).registerConnectivityIpc !== "function") {
      expect((mod as Record<string, unknown>).registerConnectivityIpc).toBeDefined();
      return;
    }

    const { registerConnectivityIpc } = mod as unknown as {
      registerConnectivityIpc: (checkFn: () => Promise<unknown>) => void;
    };

    const mockCheckFn = vi.fn().mockResolvedValue({ connectivity: "online" });
    registerConnectivityIpc(mockCheckFn);

    const handler = getHandler(OFFLINE_CHANNELS.CHECK_CONNECTIVITY);
    const result = await handler(null, { apiBaseUrl: "http://malicious.example" });

    expect(mockCheckFn).toHaveBeenCalledWith();
    expect(result).toEqual({ connectivity: "online" });
  });

  it("unregisterConnectivityIpc removes the handler", async () => {
    const mod = await import("./offline-ipc");
    if (
      typeof (mod as Record<string, unknown>).registerConnectivityIpc !== "function" ||
      typeof (mod as Record<string, unknown>).unregisterConnectivityIpc !== "function"
    ) {
      expect((mod as Record<string, unknown>).unregisterConnectivityIpc).toBeDefined();
      return;
    }

    const {
      registerConnectivityIpc,
      unregisterConnectivityIpc,
    } = mod as unknown as {
      registerConnectivityIpc: (checkFn: (params: { apiBaseUrl: string }) => Promise<unknown>) => void;
      unregisterConnectivityIpc: () => void;
    };

    const mockCheckFn = vi.fn().mockResolvedValue({ connectivity: "online" });
    registerConnectivityIpc(mockCheckFn);

    expect(getHandler(OFFLINE_CHANNELS.CHECK_CONNECTIVITY)).toBeDefined();

    unregisterConnectivityIpc();

    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(
      OFFLINE_CHANNELS.CHECK_CONNECTIVITY,
    );
  });
});
