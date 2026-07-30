export const UPDATE_CHANNELS = {
  GET_STATUS: "updates:get-status",
  CHECK: "updates:check",
  DOWNLOAD: "updates:download",
  INSTALL_AND_RESTART: "updates:install-and-restart",
  STATUS: "updates:status"
} as const;

export const OFFLINE_CHANNELS = {
  GET_STATE: "offline:get-state",
  GET_SESSION: "offline:get-session",
  LOGIN: "offline:login",
  CHECK_CONNECTIVITY: "offline:connectivity:check",
} as const;

export const BOOTSTRAP_CHANNELS = {
  BOOTSTRAP_STATUS: "offline:bootstrap:status",
  BOOTSTRAP_START: "offline:bootstrap:start",
  BOOTSTRAP_RESUME: "offline:bootstrap:resume",
} as const;

export const SALES_CHANNELS = {
  COMPLETE_SALE: "offline:sales:complete",
  GET_SALE: "offline:sales:get",
  LIST_SALES: "offline:sales:list",
} as const;

export const SYNC_CHANNELS = {
  START_SYNC: "sync:start",
  GET_SYNC_STATE: "sync:get-state",
  PULL: "sync:pull",
} as const;

export const PRODUCTS_CHANNELS = {
  CREATE: "offline:products:create",
  UPDATE: "offline:products:update",
  DELETE: "offline:products:delete",
  LIST: "offline:products:list",
  GET: "offline:products:get",
  FIND_BY_CODE: "offline:products:findByCode",
} as const;

export const STOCK_CHANNELS = {
  GET: "offline:stock:get",
  ADJUST: "offline:stock:adjust",
} as const;

export const PROMOTIONS_CHANNELS = {
  CREATE: "offline:promotions:create",
  UPDATE: "offline:promotions:update",
  DELETE: "offline:promotions:delete",
  LIST: "offline:promotions:list",
} as const;

export const PROVIDER_PURCHASES_CHANNELS = {
  CREATE: "offline:provider-purchases:create",
  UPDATE: "offline:provider-purchases:update",
  LIST: "offline:provider-purchases:list",
  DELETE: "offline:provider-purchases:delete",
} as const;

export const REPORTS_CHANNELS = {
  GET_SALES_SUMMARY: "offline:reports:sales-summary",
  GET_RECENT_SALES: "offline:reports:recent-sales",
  GET_STALENESS: "offline:reports:staleness",
} as const;

export const SUPPORT_CHANNELS = {
  LIST_OUTBOX: "outbox:list",
  RETRY_OUTBOX: "outbox:retry",
  RETRY_SALE: "outbox:retry-sale",
  RESOLVE_CONFLICT: "outbox:resolve-conflict",
  EXPORT_OUTBOX: "outbox:export",
} as const;
