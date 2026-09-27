import type { Resource } from '../../generated/prisma/client.js';

/** Представление ресурса для кабинета (01 §4: экземпляры и услуги — JSON прямо на строке, как во фронте) */

type Json = unknown;
const arr = <T = string>(v: Json): T[] => (Array.isArray(v) ? (v as T[]) : []);

export interface ResourceInstance {
  id: string;
  name: string;
}

export function resourceView(r: Resource) {
  return {
    id: r.id,
    businessId: r.businessId,
    locationId: r.locationId,
    name: r.name as Record<string, string>,
    kind: r.kind as 'chair' | 'room' | 'device' | 'box' | 'hall' | 'other',
    instances: arr<ResourceInstance>(r.instances),
    serviceIds: arr<string>(r.serviceIds),
    active: r.active,
    description: r.description ?? '',
    version: r.version,
  };
}
export type ResourceView = ReturnType<typeof resourceView>;
