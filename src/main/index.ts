import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import log from "electron-log";
import Database from "better-sqlite3";
import { encodeDesktopConfig, resolveDesktopConfig } from "./config";
import { isAllowedPermission, isAllowedRendererNavigation, shouldOpenExternally } from "./navigation";
import { startPackagedNextServer, stopPackagedNextServer } from "./next-server";
import { checkForUpdatesOnStartup, registerUpdaterIpc, unregisterUpdaterIpc } from "./updater";
import { createBusyTracker } from "./busy-state";
import { getUpdateStatus } from "./updater-status";
import { getDatabasePath, openDatabase, runMigrations, closeDatabase } from "./db";
import {
  registerOfflineIpc,
  unregisterOfflineIpc,
  registerConnectivityIpc,
  unregisterConnectivityIpc,
} from "./adapters/offline/offline-ipc";
import { OfflineService } from "./application/offline/offline-service";
import { OfflineSqliteRepository } from "./infrastructure/persistence/offline-sqlite-repository";
import { registerBootstrapIpc, unregisterBootstrapIpc } from "./adapters/bootstrap/bootstrap-ipc";
import { BootstrapService } from "./application/bootstrap/bootstrap-service";
import { BootstrapSqliteRepository } from "./infrastructure/persistence/bootstrap-sqlite-repository";
import { registerSalesIpc, unregisterSalesIpc } from "./adapters/sales/sales-ipc";
import { SaleService } from "./application/sales/sale-service";
import { SalesSqliteRepository } from "./infrastructure/persistence/sales-sqlite-repository";
import { registerSyncIpc, unregisterSyncIpc, createBackendPushFn, createBackendRevalidateFn } from "./adapters/sync/sync-ipc";
import { registerProductsIpc, unregisterProductsIpc } from "./adapters/products/products-ipc";
import { registerPromotionsIpc, unregisterPromotionsIpc } from "./adapters/promotions/promotions-ipc";
import { registerStockIpc, unregisterStockIpc } from "./adapters/stock/stock-ipc";
import { ProductService } from "./application/products/product-service";
import { PromotionService } from "./application/promotions/promotion-service";
import { ProductsSqliteRepository } from "./infrastructure/persistence/products-sqlite-repository";
import { PromotionsSqliteRepository } from "./infrastructure/persistence/promotions-sqlite-repository";
import { OutboxSqliteRepository } from "./infrastructure/persistence/outbox-sqlite-repository";
import { registerProviderPurchasesIpc, unregisterProviderPurchasesIpc } from "./adapters/provider-purchases/provider-purchases-ipc";
import { ProviderPurchaseService } from "./application/provider-purchases/provider-purchase-service";
import { ProviderPurchasesSqliteRepository } from "./infrastructure/persistence/provider-purchases-sqlite-repository";
import { StockSqliteRepository } from "./infrastructure/persistence/stock-sqlite-repository";
import { registerReportsIpc, unregisterReportsIpc } from "./adapters/reports/reports-ipc";
import { ReportService } from "./application/reports/report-service";
import { ReportsSqliteRepository } from "./infrastructure/persistence/reports-sqlite-repository";
import { registerSupportIpc, unregisterSupportIpc } from "./adapters/support/support-ipc";
import { SupportService } from "./application/support/support-service";
import { SupportSqliteRepository } from "./infrastructure/persistence/support-sqlite-repository";
import { onConnectivityChange } from "./connectivity-state";
import { startStartupConnectivityDetection, manualRetryConnectivity } from "./connectivity-check";
import { replayOutbox, recoverStaleInFlightEntries } from "./sync-engine";
import { seedDefaultAdmin } from "./offline-auth";

/** Cached auth params supplied by the renderer for automatic sync on reconnect. */
let _lastSyncAuth: { apiBaseUrl: string; token: string } | null = null;

/** Main-process busy tracker created once and shared with all protected IPC handlers. */
const busyTracker = createBusyTracker();

/** Store auth params from the renderer so reconnect-sync can re-use them. */
function setLastSyncAuth(params: { apiBaseUrl: string; token: string }): void {
  _lastSyncAuth = params;
}

log.initialize();

// ---------------------------------------------------------------------------
// Config path helper
// ---------------------------------------------------------------------------

/**
 * Resolve the path to default-config.json.
 *
 * - In packaged builds: reads from the Electron resources directory.
 * - In development: reads from the project's build/ directory so local
 *   changes to default-config.json take effect without rebuilding the package.
 */
function getDefaultConfigPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "default-config.json");
  }
  // __dirname is dist/main/ when compiled; go up two levels to project root.
  return path.join(__dirname, "../../build/default-config.json");
}

// ---------------------------------------------------------------------------
// Database lifecycle — owned by the main process
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database accessed before initialization or after shutdown");
  }
  return db;
}

function initDatabase(
  userDataPath: string,
  integrityCheckOnStartup: boolean,
  apiBaseUrl: string,
  defaultAdmin?: { username: string; password: string },
): void {
  const dbPath = getDatabasePath(userDataPath);
  log.info("Opening local database", { dbPath });

  try {
    db = openDatabase(dbPath);

    if (integrityCheckOnStartup) {
      const integrityResult = db.pragma("integrity_check") as [{ integrity_check: string }];
      if (integrityResult[0].integrity_check !== "ok") {
        log.error("Database integrity check failed", integrityResult);
        // Persist the degraded flag so the renderer sees it on every getState() call.
        db.prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('degraded', '1')",
        ).run();
      }
    }

    const applied = runMigrations(db);
    if (applied > 0) {
      log.info("Applied database migrations", { count: applied });
    } else {
      log.info("Database migrations up to date");
    }

    // Recover any entries left in_flight from a previous crash
    const recovered = recoverStaleInFlightEntries(db);
    if (recovered > 0) {
      log.info("Recovered stale in_flight entries", { count: recovered });
    }

    // Seed the default admin so the app works offline from the first launch.
    if (defaultAdmin) {
      try {
        seedDefaultAdmin(db, defaultAdmin.username, defaultAdmin.password);
        log.info("Default admin seeded", { username: defaultAdmin.username });
      } catch (err) {
        log.warn("Failed to seed default admin", err);
      }
    }
  } catch (err) {
    log.error("Database initialization failed", err);
    // If the DB handle is open, try to persist the degraded flag so the
    // renderer can discover it. This is best-effort — the metadata table
    // may not exist yet if migrations never ran.
    if (db) {
      try {
        db.prepare(
          "INSERT OR REPLACE INTO metadata (key, value) VALUES ('degraded', '1')",
        ).run();
      } catch {
        // Best effort.
      }
    }
  }

  // Always register the offline and bootstrap IPC handlers so the renderer
  // can query state, even when the database failed to initialize. Both
  // handlers return degraded/failed results when getDb() throws because db
  // is still null.
  const offlineRepository = new OfflineSqliteRepository(getDb);
  const offlineService = new OfflineService(offlineRepository);
  registerOfflineIpc(offlineService);
  const bootstrapRepository = new BootstrapSqliteRepository(getDb);
  const bootstrapService = new BootstrapService(bootstrapRepository);
  registerBootstrapIpc(bootstrapService, busyTracker);
  const outboxRepository = new OutboxSqliteRepository(getDb);
  const salesRepository = new SalesSqliteRepository(getDb, outboxRepository);
  const saleService = new SaleService(salesRepository);
  registerSalesIpc(saleService, salesRepository, busyTracker);
  registerSyncIpc(getDb, setLastSyncAuth, busyTracker);
  const productsRepository = new ProductsSqliteRepository(getDb, outboxRepository);
  const productService = new ProductService(productsRepository);
  registerProductsIpc(productService, busyTracker);
  const promotionsRepository = new PromotionsSqliteRepository(getDb, outboxRepository);
  const promotionService = new PromotionService(promotionsRepository);
  registerPromotionsIpc(promotionService, busyTracker);
  const providerPurchasesRepository = new ProviderPurchasesSqliteRepository(getDb, outboxRepository);
  const providerPurchaseService = new ProviderPurchaseService(providerPurchasesRepository);
  registerProviderPurchasesIpc(providerPurchaseService, busyTracker);
  const stockRepository = new StockSqliteRepository(getDb, outboxRepository);
  registerStockIpc(stockRepository, busyTracker);
  const reportsRepository = new ReportsSqliteRepository(getDb);
  const reportService = new ReportService(reportsRepository);
  registerReportsIpc(reportService);
  const supportRepository = new SupportSqliteRepository(getDb);
  const supportService = new SupportService(supportRepository);
  registerSupportIpc(supportService, busyTracker);

  // -------------------------------------------------------------------
      // -------------------------------------------------------------------
      // Connectivity check IPC — manual retry from the renderer
      // -------------------------------------------------------------------
      registerConnectivityIpc(async () => {
        const result = await manualRetryConnectivity(apiBaseUrl);
        return { connectivity: result };
      });

  // Connectivity-change listener: trigger whole-outbox sync on reconnect
  // -------------------------------------------------------------------
  onConnectivityChange((next, previous) => {
    // Trigger full outbox sync when connectivity returns (offline/reconnecting → online)
    if (previous !== "online" && next === "online") {
      const auth = _lastSyncAuth;
      if (auth) {
        log.info("Connectivity restored — triggering outbox sync");
        try {
          const d = getDb();
          const pushFn = createBackendPushFn(auth.apiBaseUrl, auth.token);
          const revalidateFn = createBackendRevalidateFn(auth.apiBaseUrl, auth.token);
          // Fire-and-forget — don't block the connectivity monitor
          replayOutbox(d, pushFn, revalidateFn).catch((err) =>
            log.error("Reconnect sync failed", err),
          );
        } catch (err) {
          log.warn("Reconnect sync skipped — DB not available", err);
        }
      } else {
        log.info("Connectivity restored — no cached auth, sync deferred");
      }
    }
  });
}

function shutdownDatabase(): void {
  unregisterUpdaterIpc();
  unregisterSyncIpc();
  unregisterSupportIpc();
  unregisterReportsIpc();
  unregisterProviderPurchasesIpc();
  unregisterPromotionsIpc();
  unregisterStockIpc();
  unregisterProductsIpc();
      unregisterConnectivityIpc();
  unregisterOfflineIpc();
  unregisterBootstrapIpc();
  unregisterSalesIpc();
  if (db) {
    try {
      closeDatabase(db);
      log.info("Local database closed");
    } catch (err) {
      log.error("Error closing database", err);
    }
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createBrowserWindow(encodedConfig: string): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    title: "Market Management",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: [`--market-desktop-config=${encodedConfig}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
}

function registerNavigationGuards(window: BrowserWindow, allowedRendererOrigin: string): void {
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedRendererNavigation(targetUrl, allowedRendererOrigin)) {
      return;
    }

    event.preventDefault();

    if (shouldOpenExternally(targetUrl, allowedRendererOrigin)) {
      void shell.openExternal(targetUrl);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, allowedRendererOrigin)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    try {
      const requestingOrigin = new URL(webContents.getURL()).origin;
      callback(isAllowedPermission(permission, requestingOrigin, allowedRendererOrigin));
    } catch {
      callback(false);
    }
  });
}

async function createWindow(): Promise<void> {
  const config = resolveDesktopConfig({
    appVersion: app.getVersion(),
    userConfigPath: path.join(app.getPath("userData"), "config.json"),
    defaultConfigPath: getDefaultConfigPath()
  });

  const updateStatus = getUpdateStatus(config);
  const rendererConfig = {
    ...config,
    updateEnabled: updateStatus.enabled,
    updates: {
      ...config.updates,
      enabled: updateStatus.enabled
    }
  };
  log.info("market-management-desktop starting", { updateStatus, offlineEnabled: config.offline.enabled });

  const encodedConfig = encodeDesktopConfig(rendererConfig);
  const window = createBrowserWindow(encodedConfig);

  if (process.env.MARKET_DESKTOP_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log.error("Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  window.webContents.on("did-finish-load", () => {
    log.info("Renderer finished loading", { url: window.webContents.getURL() });
  });

  window.webContents.on("destroyed", () => {
    busyTracker.clearTokensForRendererView(window.webContents.id);
    unregisterUpdaterIpc();
  });
  const updaterStatus = registerUpdaterIpc(rendererConfig, window.webContents, busyTracker);
  if (app.isPackaged) {
    checkForUpdatesOnStartup(updaterStatus);
  }

  const rendererUrl = app.isPackaged
    ? (await startPackagedNextServer()).url
    : config.frontendDevUrl;
  const allowedRendererOrigin = new URL(rendererUrl).origin;

  registerNavigationGuards(window, allowedRendererOrigin);
  await window.loadURL(rendererUrl);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    const config = resolveDesktopConfig({
      appVersion: app.getVersion(),
      userConfigPath: path.join(app.getPath("userData"), "config.json"),
      defaultConfigPath: getDefaultConfigPath()
    });

    // Initialize the local SQLite database before creating the renderer window.
    // The DB is initialized even when offline mode is disabled so the metadata
    // table can record readiness and the support surface always works.
    initDatabase(
      app.getPath("userData"),
      config.offline.integrityCheckOnStartup,
      config.apiBaseUrl,
      config.offline.defaultAdmin,
    );

        // Start proactive connectivity detection before the renderer loads.
        startStartupConnectivityDetection(config.apiBaseUrl);

    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on("before-quit", () => {
  shutdownDatabase();
  stopPackagedNextServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
