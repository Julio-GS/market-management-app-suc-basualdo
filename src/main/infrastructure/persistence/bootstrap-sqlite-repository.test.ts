// ---------------------------------------------------------------------------
// BootstrapSqliteRepository tests
//
// Uses a real in-memory SQLite database with migrations applied.
// Covers status reads, snapshot ingestion, fetch/status transitions,
// resume guard, transaction rollback, idempotency, and password_hash
// preservation. Preserves every assertion from the previous Bootstrap tests.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../db";
import { getOfflineState } from "../../offline-state";
import { getConnectivityState, setConnectivityState, resetConnectivityState } from "../../connectivity-state";
import { BootstrapSqliteRepository } from "./bootstrap-sqlite-repository";
import type { BootstrapSnapshot } from "../../domain/bootstrap/bootstrap";
import type { BootstrapResult } from "../../domain/bootstrap/bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_BACKEND_URL = "http://localhost:9999";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeSnapshot(overrides?: Partial<BootstrapSnapshot>): BootstrapSnapshot {
  return {
    products: [],
    stock_balances: [],
    promotions: [],
    provider_purchases: [],
    user_profile: {
      id: "u1",
      username: "cashier",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    },
    sync_cursor: "2024-01-15T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BootstrapSqliteRepository", () => {
  let db: Database.Database;
  let repo: BootstrapSqliteRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new BootstrapSqliteRepository(() => db);
  });

  afterEach(() => {
    db.close();
  });

  describe("getStatus", () => {
    it("returns pending when no bootstrap data exists", () => {
      const status = repo.getStatus();
      expect(status.status).toBe("pending");
      expect(status.ready).toBe(false);
      expect(status.syncCursor).toBeNull();
    });

    it("returns complete and ready after successful ingestion", async () => {
      const snapshot = makeSnapshot();
      // Ingest directly via the legacy path for status verification
      const originalFetch = globalThis.fetch;
          globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(snapshot),
          });
          await repo.start("test-token", MOCK_BACKEND_URL);
          globalThis.fetch = originalFetch;

      const status = repo.getStatus();
      expect(status.status).toBe("complete");
      expect(status.ready).toBe(true);
      expect(status.syncCursor).toBe("2024-01-15T12:00:00.000Z");
    });

    it("returns in_progress when bootstrap was started but not completed", () => {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')",
      ).run();

      const status = repo.getStatus();
      expect(status.status).toBe("in_progress");
      expect(status.ready).toBe(false);
    });

    it("returns failed when bootstrap was marked failed", () => {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
      ).run();

      const status = repo.getStatus();
      expect(status.status).toBe("failed");
      expect(status.ready).toBe(false);
    });

    it("defaults status to pending when metadata row is absent", () => {
      // Delete the default pending row created by migrations
      db.prepare("DELETE FROM metadata WHERE key = 'bootstrap_status'").run();

      const status = repo.getStatus();
      expect(status.status).toBe("pending");
    });
  });

  describe("snapshot ingestion (via start with mock fetch)", () => {
    it("persists products into the local store", async () => {
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-1",
            detalle: "Test Product",
            costo_neto: "10.00",
            costo_final: "12.10",
            iva: "21.00",
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "Test",
            facturable: true,
            maneja_stock: true,
            codigos: ["123"],
            pricing_mode: "fixed",
            is_protected: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(1);
      expect((products as { id: string }[])[0].id).toBe("p-1");

      globalThis.fetch = originalFetch;
    });

    it("persists stock balances into the local store", async () => {
      const snapshot = makeSnapshot({
        stock_balances: [
          { product_id: "p-1", stock_actual: 50, updated_at: "2024-01-02T00:00:00.000Z" },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const balances = db.prepare("SELECT * FROM stock_balances").all();
      expect(balances).toHaveLength(1);
      expect((balances as { product_id: string }[])[0].product_id).toBe("p-1");

      globalThis.fetch = originalFetch;
    });

    it("persists promotions into the local store", async () => {
      const snapshot = makeSnapshot({
        promotions: [
          {
            id: "promo-1",
            name: "Sale 10%",
            description: null,
            scope: "store",
            product_id: null,
            type: "percentage",
            discount_percent: 10,
            start_date: null,
            end_date: null,
            weekdays: null,
            enabled: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const promotions = db.prepare("SELECT * FROM promotions").all();
      expect(promotions).toHaveLength(1);

      globalThis.fetch = originalFetch;
    });

    it("clears stale promotions when the authoritative snapshot has none", async () => {
      db.prepare(`
        INSERT INTO promotions
          (id, name, description, scope, product_id, type, discount_percent, start_date, end_date, weekdays, enabled, created_at, updated_at)
        VALUES
          ('stale-promo', 'Old promo', NULL, 'store', NULL, 'percentage', 5, NULL, NULL, NULL, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
      `).run();

      const snapshot = makeSnapshot({ promotions: [] });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const promotions = db.prepare("SELECT * FROM promotions").all();
      expect(promotions).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });

    it("persists provider purchases into the local store", async () => {
      const snapshot = makeSnapshot({
        provider_purchases: [
          {
            id: "pp-1",
            provider_name: "Provider Co",
            amount: "500.00",
            payment_method: "transfer",
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const purchases = db.prepare("SELECT * FROM provider_purchases").all();
      expect(purchases).toHaveLength(1);

      globalThis.fetch = originalFetch;
    });

    it("marks bootstrap as complete and records sync cursor after ingestion", async () => {
      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'bootstrap_status'")
        .get() as { value: string };
      expect(row.value).toBe("complete");

      const cursorRow = db
        .prepare("SELECT value FROM metadata WHERE key = 'sync_cursor'")
        .get() as { value: string };
      expect(cursorRow.value).toBe("2024-01-15T12:00:00.000Z");

      globalThis.fetch = originalFetch;
    });

    it("runs ingestion in a transaction so partial failure rolls back", async () => {
      const badSnapshot = {
        ...makeSnapshot(),
        products: [{ id: "bad" } as unknown as BootstrapSnapshot["products"][0]],
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(badSnapshot),
      });

      // The repository catches ingestion errors and returns a failed result
      // (matching legacy startBootstrap behavior)
      const result = await repo.start("test-token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);

      // Products table should be empty because the transaction rolled back
      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(0);

      // Bootstrap status should NOT be complete
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'bootstrap_status'")
        .get() as { value: string };
      expect(row.value).toBe("failed");

      globalThis.fetch = originalFetch;
    });

    it("is idempotent — running ingestion twice does not duplicate data", async () => {
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-1",
            detalle: "Test",
            costo_neto: null,
            costo_final: null,
            iva: null,
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "T",
            facturable: true,
            maneja_stock: false,
            codigos: [],
            pricing_mode: "fixed",
            is_protected: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);
      await repo.start("test-token", MOCK_BACKEND_URL);

      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(1);

      globalThis.fetch = originalFetch;
    });

    it("preserves an existing password_hash when bootstrap refreshes the offline session", async () => {
      db.prepare(`
        INSERT INTO offline_sessions
          (user_id, username, last_validated_at, created_at, updated_at, password_hash)
        VALUES
          ('u1', 'cashier', '2024-01-10T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-10T00:00:00.000Z', 'salt:hash')
      `).run();

      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      const session = db
        .prepare("SELECT password_hash FROM offline_sessions WHERE user_id = 'u1'")
        .get() as { password_hash: string | null };
      expect(session.password_hash).toBe("salt:hash");

      globalThis.fetch = originalFetch;
    });

    it("keeps offline login working after bootstrap refresh preserves the cached password hash", async () => {
      const { hashPassword, verifyOfflineCredentials } = await import("../../offline-auth");
      const passwordHash = hashPassword("secret-123");

      db.prepare(`
        INSERT INTO offline_sessions
          (user_id, username, last_validated_at, created_at, updated_at, password_hash)
        VALUES
          ('u1', 'cashier', '2024-01-10T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-10T00:00:00.000Z', ?)
      `).run(passwordHash);

      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      expect(verifyOfflineCredentials(db, "cashier", "secret-123")).toEqual({
        success: true,
        userId: "u1",
        username: "cashier",
        offlineMode: true,
      });

      globalThis.fetch = originalFetch;
    });
  });

  describe("start (fetch behavior)", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("calls the backend with correct method, headers, and a timeout signal", async () => {
      const snapshot = makeSnapshot();
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy;

      await repo.start("test-token", MOCK_BACKEND_URL);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${MOCK_BACKEND_URL}/sync/bootstrap`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      });
      // PR2: bootstrap fetch MUST include an AbortSignal for bounded timeout
      expect(init.signal).toBeDefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);

      globalThis.fetch = originalFetch;
    });

    it("marks bootstrap as in_progress before the fetch call", async () => {
      const snapshot = makeSnapshot();

      const originalFetch = globalThis.fetch;
      let statusDuringFetch = "";

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        // Check what the status is during the fetch call
        const row = db
          .prepare("SELECT value FROM metadata WHERE key = 'bootstrap_status'")
          .get() as { value: string } | undefined;
        statusDuringFetch = row?.value ?? "";
        return { ok: true, json: () => Promise.resolve(snapshot) };
      });

      await repo.start("test-token", MOCK_BACKEND_URL);

      expect(statusDuringFetch).toBe("in_progress");

      globalThis.fetch = originalFetch;
    });

    it("handles HTTP 401 response and marks bootstrap as failed", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"message":"Unauthorized"}'),
      });

      const result = await repo.start("bad-token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      expect(result.error).toBeDefined();

      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("failed");

      globalThis.fetch = originalFetch;
    });

    it("handles HTTP error without JSON body and returns raw body details", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const result = await repo.start("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Backend returned status 500: Internal Server Error");

      globalThis.fetch = originalFetch;
    });

    it("handles thrown fetch error and marks bootstrap as failed", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

      const result = await repo.start("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      expect(result.error).toBe("Network failure");

      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("failed");

      globalThis.fetch = originalFetch;
    });

    it("handles non-Error thrown value during fetch", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue("crash");

      const result = await repo.start("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Unknown bootstrap error");

      globalThis.fetch = originalFetch;
    });

    it("returns failed status when bootstrap fetch aborts from timeout", async () => {
      const originalFetch = globalThis.fetch;
      // Simulate a fetch that rejects with an AbortError (DOMException)
      globalThis.fetch = vi.fn().mockRejectedValue(
        new DOMException("The operation was aborted", "AbortError"),
      );

      setConnectivityState("online");
      const result = await repo.start("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      // AbortError message should be preserved in the error field
      expect(result.error).toBe("The operation was aborted");

      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("failed");

      globalThis.fetch = originalFetch;
    });

    it("returns complete and ready on successful bootstrap", async () => {
      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      const result = await repo.start("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");
      expect(result.ready).toBe(true);

      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("complete");
      expect(state.ready).toBe(true);

      globalThis.fetch = originalFetch;
    });
  });

  describe("resume", () => {
    it("returns immediately when already complete without calling fetch", async () => {
      // Pre-seed complete state via legacy ingestion
      db.prepare(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
          ).run();
          db.prepare(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_cursor', '2024-01-15T12:00:00.000Z')",
          ).run();

      const fetchSpy = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy;

      const result = await repo.resume("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");
      expect(fetchSpy).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });

    it("restarts bootstrap (delegates to start) when status is pending", async () => {
      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      const result = await repo.resume("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");

      globalThis.fetch = originalFetch;
    });

    it("restarts bootstrap when status is in_progress", async () => {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')",
      ).run();

      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      const result = await repo.resume("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");

      globalThis.fetch = originalFetch;
    });

    it("restarts bootstrap when status is failed", async () => {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
      ).run();

      const snapshot = makeSnapshot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      const result = await repo.resume("token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");

      globalThis.fetch = originalFetch;
    });
  });

  describe("getOfflineState integration", () => {
    it("returns ready=false after getOfflineState when not bootstrapped", () => {
      const state = getOfflineState(db);
      expect(state.ready).toBe(false);
      expect(state.bootstrap).toBe("pending");
    });
  });

  describe("boolean mapping and JSON stringify contracts", () => {
    it("stores facturable as 1/0 integer in the database", async () => {
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-bool",
            detalle: "Bool Test",
            costo_neto: null,
            costo_final: null,
            iva: null,
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "T",
            facturable: true,
            maneja_stock: false,
            codigos: [],
            pricing_mode: "fixed",
            is_protected: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("token", MOCK_BACKEND_URL);

      const product = db.prepare("SELECT * FROM products WHERE id = 'p-bool'").get() as Record<string, unknown>;
      expect(product.facturable).toBe(1);
      expect(product.maneja_stock).toBe(0);
      expect(product.is_protected).toBe(1);

      globalThis.fetch = originalFetch;
    });

    it("stores codigos as JSON.stringify(array)", async () => {
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-codes",
            detalle: "Codes Test",
            costo_neto: null,
            costo_final: null,
            iva: null,
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "T",
            facturable: true,
            maneja_stock: false,
            codigos: ["CODE1", "CODE2"],
            pricing_mode: "fixed",
            is_protected: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("token", MOCK_BACKEND_URL);

      const product = db.prepare("SELECT * FROM products WHERE id = 'p-codes'").get() as Record<string, unknown>;
      expect(product.codigos).toBe('["CODE1","CODE2"]');

      globalThis.fetch = originalFetch;
    });

    it("stores weekdays as JSON.stringify(array) or null", async () => {
      const snapshot = makeSnapshot({
        promotions: [
          {
            id: "promo-wd",
            name: "Weekdays Promo",
            description: null,
            scope: "store",
            product_id: null,
            type: "percentage",
            discount_percent: 10,
            start_date: null,
            end_date: null,
            weekdays: [1, 3, 5],
            enabled: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
          {
            id: "promo-null",
            name: "No Weekdays",
            description: null,
            scope: "store",
            product_id: null,
            type: "percentage",
            discount_percent: 5,
            start_date: null,
            end_date: null,
            weekdays: null,
            enabled: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("token", MOCK_BACKEND_URL);

      const promoWd = db.prepare("SELECT weekdays FROM promotions WHERE id = 'promo-wd'").get() as { weekdays: string };
      const promoNull = db.prepare("SELECT weekdays FROM promotions WHERE id = 'promo-null'").get() as { weekdays: string | null };

      expect(promoWd.weekdays).toBe("[1,3,5]");
      expect(promoNull.weekdays).toBeNull();

      globalThis.fetch = originalFetch;
    });

    it("stores enabled as 1/0 integer", async () => {
      const snapshot = makeSnapshot({
        promotions: [
          {
            id: "promo-e",
            name: "Enabled Test",
            description: null,
            scope: "store",
            product_id: null,
            type: "percentage",
            discount_percent: 10,
            start_date: null,
            end_date: null,
            weekdays: null,
            enabled: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      await repo.start("token", MOCK_BACKEND_URL);

      const promo = db.prepare("SELECT enabled FROM promotions WHERE id = 'promo-e'").get() as { enabled: number };
      expect(promo.enabled).toBe(1);

      globalThis.fetch = originalFetch;
    });
  });
});
