import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../common/prisma.service.js';

/** Тип доп. поля клиента (F-04-140) */
export interface CustomFieldDef {
  id: string;
  label: string;
  type: 'text' | 'number' | 'list' | 'date';
  options?: string[];
  required: boolean;
  apiKey: string;
  editableByClient: boolean;
  alwaysShowInClientCard: boolean;
  alwaysShowInBookingWindow: boolean;
}

/** Настройки клиентской базы бизнеса (arch-a1 №2) — один JSON в business_settings, area='clients' (F4) */
export interface ClientsBizSettings {
  autoSaveChatLeads: boolean;
  lostAfterDays: number;
  showFullNameFields: boolean;
  customFieldDefs: CustomFieldDef[];
  showLoyaltySearchInBookingWindow: boolean;
}

export function defaultClientsBizSettings(): ClientsBizSettings {
  return { autoSaveChatLeads: false, lostAfterDays: 60, showFullNameFields: true, customFieldDefs: [], showLoyaltySearchInBookingWindow: false };
}

const AREA = 'clients';

export async function getClientsBizSettings(prisma: PrismaService, businessId: string): Promise<ClientsBizSettings> {
  const row = await prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
  return { ...defaultClientsBizSettings(), ...((row?.data as Partial<ClientsBizSettings>) ?? {}) };
}

export async function patchClientsBizSettings(prisma: PrismaService, businessId: string, patch: Partial<ClientsBizSettings>): Promise<ClientsBizSettings> {
  const current = await getClientsBizSettings(prisma, businessId);
  const next = { ...current, ...patch };
  await prisma.businessSetting.upsert({
    where: { businessId_area: { businessId, area: AREA } },
    create: { businessId, area: AREA, data: next as unknown as Prisma.InputJsonValue },
    update: { data: next as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  return next;
}
