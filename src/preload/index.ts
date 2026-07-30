import { contextBridge, ipcRenderer } from "electron";
import { type DesktopConfig, decodeDesktopConfig } from "../shared/desktop-config";
import {
  BOOTSTRAP_CHANNELS,
  OFFLINE_CHANNELS,
  PRODUCTS_CHANNELS,
  PROMOTIONS_CHANNELS,
  STOCK_CHANNELS,
  PROVIDER_PURCHASES_CHANNELS,
  REPORTS_CHANNELS,
  SALES_CHANNELS,
  SUPPORT_CHANNELS,
  SYNC_CHANNELS,
  UPDATE_CHANNELS,
} from "../shared/ipc-channels";
import type { UpdateEventPayload, UpdateStatusPayload } from "../main/updater";
import type {
  OfflineLoginParams,
  OfflineLoginIpcResult,
  OfflineSessionIpcResult,
} from "../main/adapters/offline/offline-ipc";
import type { BootstrapResult } from "../main/adapters/bootstrap/bootstrap-ipc";
import type { DetailedListedSale, OfflineSaleIpcResult } from "../main/adapters/sales/sales-ipc";
import type { OutboxListItem, OutboxRetryResult } from "../main/adapters/support/support-ipc";
import type { OfflineState } from "../main/offline-state";
import type { OfflineSaleInput } from "../main/adapters/sales/sales-ipc";
import type { SyncStatePayload } from "../main/adapters/sync/sync-ipc";
import type { PullResult } from "../main/pull-reconciliation";
import type { ReplayResult } from "../main/sync-engine";
import type { OfflineProductInput, OfflineProductUpdateInput, OfflineProductResult } from "../main/adapters/products/products-ipc";
import type {
  OfflinePromotionInput,
  OfflinePromotionUpdateInput,
  OfflinePromotionResult,
} from "../main/adapters/promotions/promotions-ipc";
import type { OfflineProviderPurchaseInput, OfflineProviderPurchaseUpdateInput, OfflineProviderPurchaseResult } from "../main/adapters/provider-purchases/provider-purchases-ipc";
import type { OfflineStockAdjustmentResult, OfflineStockMovement } from "../main/adapters/stock/stock-ipc";

interface MarketDesktopBridge {
  getConfig(): DesktopConfig;
  platform: NodeJS.Platform;
  updates: {
    getStatus(): Promise<UpdateStatusPayload>;
    check(): Promise<unknown>;
    download(): Promise<unknown>;
    installAndRestart(): Promise<unknown>;
    onStatus(callback: (payload: UpdateStatusPayload & UpdateEventPayload) => void): () => void;
  };
  offline: {
    getState(): Promise<OfflineState>;
    getSession(): Promise<OfflineSessionIpcResult | null>;
    login(params: OfflineLoginParams): Promise<OfflineLoginIpcResult>;
    checkConnectivity(): Promise<{ connectivity: string }>;
  };
  bootstrap: {
    status(): Promise<BootstrapResult>;
    start(params: { token: string; apiBaseUrl: string }): Promise<BootstrapResult>;
    resume(params: { token: string; apiBaseUrl: string }): Promise<BootstrapResult>;
  };
  sales: {
    complete(input: OfflineSaleInput): Promise<OfflineSaleIpcResult>;
    get(saleId: string): Promise<OfflineSaleIpcResult>;
    list(): Promise<DetailedListedSale[]>;
  };
  stock: {
    get(productId: string): Promise<number | null>;
    adjust(input: { productId: string; quantity: number; reason?: string }): Promise<OfflineStockMovement>;
  };
  sync: {
    getState(): Promise<SyncStatePayload>;
    start(params?: { apiBaseUrl?: string; token?: string }): Promise<ReplayResult>;
    pull(params?: { apiBaseUrl?: string; token?: string }): Promise<PullResult>;
  };
  products: {
    create(input: OfflineProductInput): Promise<OfflineProductResult>;
    update(id: string, input: OfflineProductUpdateInput): Promise<OfflineProductResult>;
    delete(id: string): Promise<OfflineProductResult>;
    list(filters?: { search?: string }): Promise<OfflineProductResult[]>;
    get(id: string): Promise<OfflineProductResult>;
    findByCode(code: string): Promise<OfflineProductResult>;
  };
  promotions: {
    create(input: OfflinePromotionInput): Promise<OfflinePromotionResult>;
    update(id: string, input: OfflinePromotionUpdateInput): Promise<OfflinePromotionResult>;
    delete(id: string): Promise<OfflinePromotionResult>;
    list(): Promise<OfflinePromotionResult[]>;
  };
  providerPurchases: {
    create(input: OfflineProviderPurchaseInput): Promise<OfflineProviderPurchaseResult>;
    update(id: string, input: OfflineProviderPurchaseUpdateInput): Promise<OfflineProviderPurchaseResult>;
    list(): Promise<OfflineProviderPurchaseResult[]>;
    delete(id: string): Promise<OfflineProviderPurchaseResult>;
  };
  reports: {
    getSalesSummary(): Promise<unknown>;
    getRecentSales(limit?: number): Promise<unknown>;
    getStaleness(): Promise<unknown>;
  };
  support: {
    listOutbox(filter?: { status?: string }): Promise<OutboxListItem[]>;
    retryOutbox(id: string, opts?: { confirmManualFix?: boolean }): Promise<OutboxRetryResult>;
    retrySale(saleId: string): Promise<OutboxRetryResult>;
    resolveConflict(outboxId: string, params: { resolution: "keep_local" | "use_server" }): Promise<OutboxRetryResult>;
    exportOutbox(): Promise<OutboxListItem[]>;
  };
}

function readEncodedDesktopConfig(): string | undefined {
  const prefix = "--market-desktop-config=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

const encodedConfig = readEncodedDesktopConfig();
const desktopConfig: DesktopConfig = encodedConfig
  ? decodeDesktopConfig(encodedConfig)
  : {
      apiBaseUrl: "http://localhost:3000/api/v1",
      frontendDevUrl: "http://localhost:3001",
      appVersion: "0.0.0",
      updateEnabled: false,
      updates: { enabled: false },
      offline: { enabled: false, integrityCheckOnStartup: true }
    };

const marketDesktop: MarketDesktopBridge = {
  getConfig: () => desktopConfig,
  platform: process.platform,
  updates: {
    getStatus: () => ipcRenderer.invoke(UPDATE_CHANNELS.GET_STATUS) as Promise<UpdateStatusPayload>,
    check: () => ipcRenderer.invoke(UPDATE_CHANNELS.CHECK),
    download: () => ipcRenderer.invoke(UPDATE_CHANNELS.DOWNLOAD),
    installAndRestart: () => ipcRenderer.invoke(UPDATE_CHANNELS.INSTALL_AND_RESTART),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatusPayload & UpdateEventPayload) => callback(payload);
      ipcRenderer.on(UPDATE_CHANNELS.STATUS, listener);
      return () => ipcRenderer.off(UPDATE_CHANNELS.STATUS, listener);
    }
  },
  offline: {
    getState: () => ipcRenderer.invoke(OFFLINE_CHANNELS.GET_STATE) as Promise<OfflineState>,
    getSession: () => ipcRenderer.invoke(OFFLINE_CHANNELS.GET_SESSION) as Promise<OfflineSessionIpcResult | null>,
    login: (params: OfflineLoginParams) => ipcRenderer.invoke(OFFLINE_CHANNELS.LOGIN, params) as Promise<OfflineLoginIpcResult>,
    checkConnectivity: () =>
      ipcRenderer.invoke(OFFLINE_CHANNELS.CHECK_CONNECTIVITY) as Promise<{ connectivity: string }>,
  },
  bootstrap: {
    status: () => ipcRenderer.invoke(BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS) as Promise<BootstrapResult>,
    start: (params) => ipcRenderer.invoke(BOOTSTRAP_CHANNELS.BOOTSTRAP_START, params) as Promise<BootstrapResult>,
    resume: (params) => ipcRenderer.invoke(BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME, params) as Promise<BootstrapResult>,
  },
  sales: {
    complete: (input) => ipcRenderer.invoke(SALES_CHANNELS.COMPLETE_SALE, input) as Promise<OfflineSaleIpcResult>,
    get: (saleId) => ipcRenderer.invoke(SALES_CHANNELS.GET_SALE, saleId) as Promise<OfflineSaleIpcResult>,
    list: () => ipcRenderer.invoke(SALES_CHANNELS.LIST_SALES) as Promise<DetailedListedSale[]>,
  },
  stock: {
    get: (productId) => ipcRenderer.invoke(STOCK_CHANNELS.GET, productId) as Promise<number | null>,
    adjust: async (input) => {
      const result = await ipcRenderer.invoke(STOCK_CHANNELS.ADJUST, input) as OfflineStockAdjustmentResult
      if (!result.success || !result.movement) {
        throw new Error(result.error ?? "Stock adjustment failed")
      }
      return result.movement
    },
  },
  sync: {
    getState: () => ipcRenderer.invoke(SYNC_CHANNELS.GET_SYNC_STATE) as Promise<SyncStatePayload>,
    start: (params?: { apiBaseUrl?: string; token?: string }) =>
      ipcRenderer.invoke(SYNC_CHANNELS.START_SYNC, params) as Promise<ReplayResult>,
    pull: (params?: { apiBaseUrl?: string; token?: string }) =>
      ipcRenderer.invoke(SYNC_CHANNELS.PULL, params) as Promise<PullResult>,
  },
  products: {
    create: (input) => ipcRenderer.invoke(PRODUCTS_CHANNELS.CREATE, input) as Promise<OfflineProductResult>,
    update: (id, input) => ipcRenderer.invoke(PRODUCTS_CHANNELS.UPDATE, id, input) as Promise<OfflineProductResult>,
    delete: (id) => ipcRenderer.invoke(PRODUCTS_CHANNELS.DELETE, id) as Promise<OfflineProductResult>,
    list: (filters?) => ipcRenderer.invoke(PRODUCTS_CHANNELS.LIST, filters) as Promise<OfflineProductResult[]>,
    get: (id) => ipcRenderer.invoke(PRODUCTS_CHANNELS.GET, id) as Promise<OfflineProductResult>,
    findByCode: (code) => ipcRenderer.invoke(PRODUCTS_CHANNELS.FIND_BY_CODE, code) as Promise<OfflineProductResult>,
  },
  promotions: {
    create: (input) => ipcRenderer.invoke(PROMOTIONS_CHANNELS.CREATE, input) as Promise<OfflinePromotionResult>,
    update: (id, input) => ipcRenderer.invoke(PROMOTIONS_CHANNELS.UPDATE, id, input) as Promise<OfflinePromotionResult>,
    delete: (id) => ipcRenderer.invoke(PROMOTIONS_CHANNELS.DELETE, id) as Promise<OfflinePromotionResult>,
    list: () => ipcRenderer.invoke(PROMOTIONS_CHANNELS.LIST) as Promise<OfflinePromotionResult[]>,
  },
  providerPurchases: {
    create: (input) => ipcRenderer.invoke(PROVIDER_PURCHASES_CHANNELS.CREATE, input) as Promise<OfflineProviderPurchaseResult>,
    update: (id, input) => ipcRenderer.invoke(PROVIDER_PURCHASES_CHANNELS.UPDATE, id, input) as Promise<OfflineProviderPurchaseResult>,
    list: () => ipcRenderer.invoke(PROVIDER_PURCHASES_CHANNELS.LIST) as Promise<OfflineProviderPurchaseResult[]>,
    delete: (id) => ipcRenderer.invoke(PROVIDER_PURCHASES_CHANNELS.DELETE, id) as Promise<OfflineProviderPurchaseResult>,
  },
  reports: {
    getSalesSummary: () => ipcRenderer.invoke(REPORTS_CHANNELS.GET_SALES_SUMMARY),
    getRecentSales: (limit?: number) => ipcRenderer.invoke(REPORTS_CHANNELS.GET_RECENT_SALES, limit),
    getStaleness: () => ipcRenderer.invoke(REPORTS_CHANNELS.GET_STALENESS),
  },
  support: {
    listOutbox: (filter) => ipcRenderer.invoke(SUPPORT_CHANNELS.LIST_OUTBOX, filter) as Promise<OutboxListItem[]>,
    retryOutbox: (id: string, opts?: { confirmManualFix?: boolean }) =>
      ipcRenderer.invoke(SUPPORT_CHANNELS.RETRY_OUTBOX, id, opts) as Promise<OutboxRetryResult>,
    retrySale: (saleId: string) => ipcRenderer.invoke(SUPPORT_CHANNELS.RETRY_SALE, saleId) as Promise<OutboxRetryResult>,
    resolveConflict: (outboxId: string, params: { resolution: "keep_local" | "use_server" }) =>
      ipcRenderer.invoke(SUPPORT_CHANNELS.RESOLVE_CONFLICT, outboxId, params) as Promise<OutboxRetryResult>,
    exportOutbox: () => ipcRenderer.invoke(SUPPORT_CHANNELS.EXPORT_OUTBOX) as Promise<OutboxListItem[]>,
  },
};

contextBridge.exposeInMainWorld("__MARKET_DESKTOP_CONFIG__", desktopConfig);
contextBridge.exposeInMainWorld("marketDesktop", marketDesktop);
