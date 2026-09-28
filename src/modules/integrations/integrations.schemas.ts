import { z } from 'zod';

const id32 = z.string().min(1).max(32);
/** Строковый код приложения каталога (каталог живёт на фронте — см. schema.prisma «Этап 17») */
const appId = z.string().min(1).max(60);

// ─────────── API-ключи (F-13-052/053/071/072) ───────────

export const apiKeyKind = z.enum(['partner', 'userToken', 'aiAssistant']);
export const aiTokenScope = z.enum(['read', 'readWrite']);

export const issuePartnerKeyBody = z.object({});
export const issueUserTokenBody = z.object({ label: z.string().trim().min(1).max(120) });
export const issueAiTokenBody = z.object({ scope: aiTokenScope });

export const apiKeyOut = z.object({
  id: z.string(),
  businessId: z.string(),
  kind: apiKeyKind,
  label: z.string().optional(),
  scope: aiTokenScope.optional(),
  /** Полный секрет — только в ответе на выпуск; в списке это уже маскированное превью (см. PROGRESS.md) */
  token: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});
export type ApiKeyOut = z.infer<typeof apiKeyOut>;

// ─────────── Вебхуки (F-13-062…070) ───────────

export const webhookEntity = z.enum([
  'location',
  'staff',
  'goods',
  'services',
  'serviceCategories',
  'clients',
  'records',
  'loyaltyCards',
  'goodsSales',
  'goodsArrival',
  'goodsWriteOff',
  'goodsConsumables',
  'goodsTransfer',
  'transactions',
  'certificates',
  'subscriptions',
]);
export type WebhookEntity = z.infer<typeof webhookEntity>;

export const setWebhookEnabledBody = z.object({ enabled: z.boolean() });
export const setWebhookEntitiesBody = z.object({ entities: z.array(webhookEntity).max(16) });

export const webhookAddressOut = z.object({
  id: z.string(),
  url: z.string(),
  createdAt: z.string(),
  legacy: z.boolean(),
  signingSecret: z.string().optional(),
  verifiedAt: z.string().optional(),
});
export const webhookConfigOut = z.object({
  businessId: z.string(),
  enabled: z.boolean(),
  addresses: z.array(webhookAddressOut),
  entities: z.array(webhookEntity),
});
export type WebhookConfigOut = z.infer<typeof webhookConfigOut>;

// ─────────── Ревью 27.09 (И13): адреса вебхуков ───────────

export const addWebhookAddressBody = z.object({ url: z.string().trim().min(1).max(500) });
export const addWebhookAddressOut = z.object({ address: webhookAddressOut, secret: z.string() });
export type AddWebhookAddressOut = z.infer<typeof addWebhookAddressOut>;

export const webhookDeliveryOut = z.object({
  id: z.string(),
  businessId: z.string(),
  entity: webhookEntity,
  action: z.enum(['create', 'update', 'delete']),
  objectLabel: z.string(),
  address: z.string(),
  status: z.enum(['delivered', 'failed']),
  createdAt: z.string(),
  failReason: z.enum(['timeout', 'http4xx', 'http5xx', 'tls']).optional(),
  attempts: z.number().optional(),
});
export type WebhookDeliveryOut = z.infer<typeof webhookDeliveryOut>;

// ─────────── Подключения каталожных приложений (F-13-014…021, Р19: только статус) ───────────

export const requestedScope = z.enum(['schedule', 'clients', 'bookings', 'money', 'staff', 'services', 'catalog', 'reports']);
export type RequestedScope = z.infer<typeof requestedScope>;
export const installStatus = z.enum(['pendingActivation', 'connected', 'error', 'disconnected', 'autoDisconnected']);

export const connectAppBody = z.object({
  appId,
  locationIds: z.array(id32).min(1).max(200),
  scopes: z.array(requestedScope).max(8).default([]),
  /** Считает фронт из своего каталога (CatalogApp.builtin) — сервер не хранит контент каталога */
  instant: z.boolean().default(false),
});
export type ConnectAppBody = z.infer<typeof connectAppBody>;

// Этап 21 (лейн notify+integrations, попытка 3): каналы каскада чат-бота (F-13-146/147) — свой enum, не
// пересекается с webhookEntity выше.
export const appChannel = z.enum(['sms', 'whatsapp', 'waba', 'telegram', 'viber', 'email', 'voice', 'other']);
export type AppChannel = z.infer<typeof appChannel>;

export const gaDataStreamOut = z.object({ id: z.string(), streamId: z.string(), formLabel: z.string(), createdAt: z.string() });

export const appInstallOut = z.object({
  id: z.string(),
  appId: z.string(),
  businessId: z.string(),
  locationId: z.string(),
  status: installStatus,
  grantedScopes: z.array(requestedScope),
  connectedAt: z.string(),
  activatesBy: z.string().optional(),
  activatedAt: z.string().optional(),
  disconnectedAt: z.string().optional(),
  paidUntil: z.string().optional(),
  systemUserId: z.string().optional(),
  errorText: z.string().optional(),
  lastEventAt: z.string().optional(),
  lastEventKind: z.enum(['sync', 'message', 'booking']).optional(),
  recentErrors: z.array(z.object({ id: z.string(), at: z.string(), reason: z.string() })).optional(),
  lastTest: z.object({ at: z.string(), ok: z.boolean(), reason: z.string().optional() }).optional(),
  // ── этап 21 (лейн notify+integrations), попытка 3: b03/b04 настройки конкретного приложения (Р19: наше
  // хранение статуса/настроек чужого приложения, без настоящего обмена) — IntegrationConnection.config JSON ──
  authKey: z.string().optional(),
  senderName: z.string().optional(),
  senderNameStatus: z.enum(['none', 'pending', 'approved']).optional(),
  whatsappNumberMode: z.enum(['default', 'own']).optional(),
  metaTemplatesApproved: z.boolean().optional(),
  gaStreams: z.array(gaDataStreamOut).optional(),
  kommoSyncMode: z.enum(['conditional', 'unconditional', 'none']).optional(),
  kommoDedupe: z.boolean().optional(),
  cascadeOrder: z.array(appChannel).optional(),
  negativeReviewIntercept: z.boolean().optional(),
});
export type AppInstallOut = z.infer<typeof appInstallOut>;

// ─────────── Ревью 27.09 (И2): «Отправить тест» ───────────

export const installTestOut = z.object({ at: z.string(), ok: z.boolean(), reason: z.string().optional() });
export type InstallTestOut = z.infer<typeof installTestOut>;

export const systemUserOut = z.object({
  id: z.string(),
  appId: z.string(),
  installId: z.string(),
  businessId: z.string(),
  locationId: z.string(),
  grantedScopes: z.array(requestedScope),
  connectedAt: z.string(),
  billedInSubscription: z.boolean(),
});
export type SystemUserOut = z.infer<typeof systemUserOut>;

// ─────────── Этап 21 (лейн notify+integrations), попытка 3: b03/b04 настройки install-а (Р19) ───────────

export const setSmsAggregatorAuthBody = z.object({ authKey: z.string().max(200), senderName: z.string().min(1).max(40) });
export const setWhatsappNumberModeBody = z.object({ mode: z.enum(['default', 'own']) });
export const setCascadeOrderBody = z.object({ order: z.array(appChannel).max(8) });
export const setNegativeReviewInterceptBody = z.object({ on: z.boolean() });
export const addGaStreamBody = z.object({ streamId: z.string().min(1).max(40), formLabel: z.string().min(1).max(120) });
export const updateGaStreamBody = z.object({ streamId: z.string().min(1).max(40), formLabel: z.string().min(1).max(120) });
export const setKommoSyncModeBody = z.object({ mode: z.enum(['conditional', 'unconditional', 'none']) });
export const setKommoDedupeBody = z.object({ dedupe: z.boolean() });

// ─────────── Идентификаторы для внешних систем (F-13-056) ───────────

export const identifiersOut = z.object({
  businessId: z.string(),
  locations: z.array(z.object({ id: z.string(), name: z.string() })),
  staff: z.array(z.object({ id: z.string(), name: z.string() })),
  services: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type IdentifiersOut = z.infer<typeof identifiersOut>;

export const locationOptionOut = z.object({ id: z.string(), name: z.string() });
