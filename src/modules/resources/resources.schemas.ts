import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';

const id32 = z.string().min(1).max(32);
export const resourceKind = z.enum(['chair', 'room', 'device', 'box', 'hall', 'other']);

export const resourceCreateBody = z.object({
  locationId: id32,
  name: localized,
  description: z.string().max(2000).optional(),
  kind: resourceKind,
  serviceIds: z.array(id32).max(500).default([]),
});
export type ResourceCreateBody = z.infer<typeof resourceCreateBody>;

export const resourceUpdateBody = z
  .object({
    name: localized,
    kind: resourceKind,
    serviceIds: z.array(id32).max(500),
    description: z.string().max(2000),
    active: z.boolean(),
  })
  .partial();
export type ResourceUpdateBody = z.infer<typeof resourceUpdateBody>;

/** «Отменить» удаление ресурса (F-00-061) — снимок держит экран, восстанавливает тем же id */
export const restoreResourceBody = z.object({
  resource: z
    .object({
      id: id32,
      locationId: id32,
      name: localized,
      kind: resourceKind,
      instances: z.array(z.object({ id: z.string().max(40), name: z.string().max(60) })).max(50).default([]),
      serviceIds: z.array(id32).max(500).default([]),
      active: z.boolean().default(true),
    })
    .catchall(z.unknown()),
  description: z.string().max(2000).optional(),
});
export type RestoreResourceBody = z.infer<typeof restoreResourceBody>;

export const instanceBody = z.object({ name: z.string().max(60) });
export const resourceServicesBody = z.object({ serviceIds: z.array(id32).max(500) });
export const toggleServiceBody = z.object({ linked: z.boolean() });
export const splitByResourceBody = z.object({ value: z.boolean() });

// ─────────── пакеты — см. services.schemas.ts (пакет — та же таблица services) ───────────

// ─────────── ответы (OpenAPI) ───────────

export const resourceOut = z.object({
  id: z.string(),
  businessId: z.string(),
  locationId: z.string(),
  name: localized,
  kind: resourceKind,
  instances: z.array(z.object({ id: z.string(), name: z.string() })),
  serviceIds: z.array(z.string()),
  active: z.boolean(),
  description: z.string(),
  version: z.number(),
});

export const changeLogEntryOut = z.object({
  id: z.string(),
  businessId: z.string(),
  entity: z.enum(['resource', 'package']),
  entityId: z.string(),
  action: z.enum(['create', 'update', 'delete', 'restore']),
  actorName: z.string(),
  at: z.string(),
  summary: z.string(),
});
