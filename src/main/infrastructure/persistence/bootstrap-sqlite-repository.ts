// ---------------------------------------------------------------------------
// Infrastructure: Bootstrap SQLite repository
//
// Contains all SQLite metadata reads/writes, snapshot fetch/ingestion,
// transaction handling, error parsing, and status transitions.
// Implements IBootstrapRepository. Preserves legacy behavior exactly.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { IBootstrapRepository } from "../../domain/bootstrap/bootstrap-repository";
import type { BootstrapSnapshot, BootstrapResult } from "../../domain/bootstrap/bootstrap";
import { setConnectivityState } from "../../connectivity-state";
import { fetchWithTimeout, BOOTSTRAP_FETCH_TIMEOUT_MS } from "../../fetch-timeout";

export class BootstrapSqliteRepository implements IBootstrapRepository {
  constructor(private readonly getDb: () => Database.Database) {}

  // ---------------------------------------------------------------------------
  // Status query
  // ---------------------------------------------------------------------------

  getStatus(): BootstrapResult {
    const db = this.getDb();

    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
      .get();

    if (!tableExists) {
      return { status: "pending", ready: false, syncCursor: null };
    }

    const rows = db
      .prepare("SELECT key, value FROM metadata WHERE key IN ('bootstrap_status','sync_cursor')")
      .all() as { key: string; value: string }[];

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const status = (map.get("bootstrap_status") ?? "pending") as BootstrapResult["status"];
    const syncCursor = map.get("sync_cursor") || null;

    return {
      status,
      ready: status === "complete",
      syncCursor,
    };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap orchestration
  // ---------------------------------------------------------------------------

  async start(token: string, apiBaseUrl: string): Promise<BootstrapResult> {
    const db = this.getDb();

    // Mark in_progress before the network call
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')",
    ).run();

    try {
      const response = await fetchWithTimeout(
        `${apiBaseUrl}/sync/bootstrap`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        BOOTSTRAP_FETCH_TIMEOUT_MS,
      );

      if (!response.ok) {
        const body = await response.text();
        const message = tryParseErrorMessage(body, response.status, response.statusText);
        setConnectivityState("offline");
        db.prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
        ).run();
        return { status: "failed", ready: false, syncCursor: null, error: message };
      }

      const snapshot = (await response.json()) as BootstrapSnapshot;
      this.ingestSnapshot(db, snapshot);
      setConnectivityState("online");

      return this.getStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown bootstrap error";
      setConnectivityState("offline");
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
      ).run();
      return { status: "failed", ready: false, syncCursor: null, error: message };
    }
  }

  async resume(token: string, apiBaseUrl: string): Promise<BootstrapResult> {
    const current = this.getStatus();

    if (current.status === "complete") {
      return current;
    }

    // pending, in_progress, or failed — restart
    return this.start(token, apiBaseUrl);
  }

  // ---------------------------------------------------------------------------
  // Snapshot ingestion (private)
  // ---------------------------------------------------------------------------

  private ingestSnapshot(db: Database.Database, snapshot: BootstrapSnapshot): void {
    const run = db.transaction(() => {
      db.prepare("DELETE FROM products").run();
      db.prepare("DELETE FROM stock_balances").run();
      db.prepare("DELETE FROM promotions").run();
      db.prepare("DELETE FROM provider_purchases").run();

      // Products
      const insertProduct = db.prepare(`
        INSERT OR REPLACE INTO products
          (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
           etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
           created_at, updated_at)
        VALUES
          (@id, @detalle, @costo_neto, @costo_final, @iva, @cambio_costo, @cambio_precio,
           @etiqueta, @facturable, @maneja_stock, @codigos, @pricing_mode, @is_protected,
           @created_at, @updated_at)
      `);

      for (const p of snapshot.products) {
        insertProduct.run({
          id: p.id,
          detalle: p.detalle,
          costo_neto: p.costo_neto,
          costo_final: p.costo_final,
          iva: p.iva,
          cambio_costo: p.cambio_costo,
          cambio_precio: p.cambio_precio,
          etiqueta: p.etiqueta,
          facturable: p.facturable ? 1 : 0,
          maneja_stock: p.maneja_stock ? 1 : 0,
          codigos: JSON.stringify(p.codigos),
          pricing_mode: p.pricing_mode,
          is_protected: p.is_protected ? 1 : 0,
          created_at: p.created_at,
          updated_at: p.updated_at,
        });
      }

      // Stock balances
      const insertStock = db.prepare(`
        INSERT OR REPLACE INTO stock_balances
          (product_id, stock_actual, updated_at)
        VALUES
          (@product_id, @stock_actual, @updated_at)
      `);

      for (const s of snapshot.stock_balances) {
        insertStock.run({
          product_id: s.product_id,
          stock_actual: s.stock_actual,
          updated_at: s.updated_at,
        });
      }

      // Promotions
      const insertPromotion = db.prepare(`
        INSERT OR REPLACE INTO promotions
          (id, name, description, scope, product_id, type, discount_percent,
           start_date, end_date, weekdays, enabled, created_at, updated_at)
        VALUES
          (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
           @start_date, @end_date, @weekdays, @enabled, @created_at, @updated_at)
      `);

      for (const p of snapshot.promotions) {
        insertPromotion.run({
          id: p.id,
          name: p.name,
          description: p.description,
          scope: p.scope,
          product_id: p.product_id,
          type: p.type,
          discount_percent: p.discount_percent,
          start_date: p.start_date,
          end_date: p.end_date,
          weekdays: p.weekdays ? JSON.stringify(p.weekdays) : null,
          enabled: p.enabled ? 1 : 0,
          created_at: p.created_at,
          updated_at: p.updated_at,
        });
      }

      // Provider purchases
      const insertProviderPurchase = db.prepare(`
        INSERT OR REPLACE INTO provider_purchases
          (id, provider_name, amount, payment_method, created_at, updated_at)
        VALUES
          (@id, @provider_name, @amount, @payment_method, @created_at, @updated_at)
      `);

      for (const pp of snapshot.provider_purchases) {
        insertProviderPurchase.run({
          id: pp.id,
          provider_name: pp.provider_name,
          amount: pp.amount,
          payment_method: pp.payment_method,
          created_at: pp.created_at,
          updated_at: pp.updated_at,
        });
      }

      // Offline session — record the user who bootstrapped
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO offline_sessions
          (user_id, username, last_validated_at, created_at, updated_at, password_hash)
        VALUES
          (@user_id, @username, @last_validated_at, @created_at, @updated_at, NULL)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          last_validated_at = excluded.last_validated_at,
          updated_at = excluded.updated_at,
          password_hash = offline_sessions.password_hash
      `).run({
        user_id: snapshot.user_profile.id,
        username: snapshot.user_profile.username,
        last_validated_at: now,
        created_at: snapshot.user_profile.created_at,
        updated_at: now,
      });

      // Mark bootstrap as complete
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
      ).run();
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_cursor', ?)",
      ).run(snapshot.sync_cursor);
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', ?)",
      ).run(now);
    });

    run();
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

function tryParseErrorMessage(body: string, status: number, statusText?: string): string {
  const prefix = `Backend returned status ${status}${statusText ? ` ${statusText}` : ""}`;

  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) {
      return `${prefix}: ${parsed.message}`;
    }
  } catch {
    // fall through to raw body
  }

  const trimmed = body.trim();
  return trimmed.length > 0 ? `${prefix}: ${trimmed}` : prefix;
}
