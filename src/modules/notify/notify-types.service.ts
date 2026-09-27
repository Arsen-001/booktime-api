import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { isLocale, t, type Locale } from '../../common/i18n/i18n.js';
import { NOTIFY_KINDS, notifyKindOf } from './kinds.js';

const AREA = 'notify-types';
const J = (v: unknown) => v as Prisma.InputJsonValue;
const R = (v: unknown) => v as Record<string, unknown>;

/** Читает свои настройки типа для бизнеса напрямую (без DI) — использует и сервис ниже, и отправитель очереди */
export async function readStoredTypes(prisma: PrismaService, businessId: string): Promise<StoredTypes> {
  const row = await prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
  return (row?.data as StoredTypes | undefined) ?? {};
}

export async function isKindEnabled(prisma: PrismaService, businessId: string, kind: string): Promise<boolean> {
  const stored = await readStoredTypes(prisma, businessId);
  return stored[kind]?.enabled ?? true;
}

export async function customTemplateOf(prisma: PrismaService, businessId: string, kind: string, locale: Locale): Promise<string | undefined> {
  const stored = await readStoredTypes(prisma, businessId);
  const push = stored[kind]?.templates?.push;
  return push?.[locale] ?? push?.ru;
}

/** LocalizedText — ровно то, что читает pickText() фронта (только ru обязателен, F-05-010) */
export type LocalizedText = { ru: string; hy?: string; en?: string };
type NotifyChannel = 'push';
type NotifyChannelSetting = { channel: NotifyChannel; scenario: 'off' | 'always' };
interface StoredType {
  enabled?: boolean;
  channels?: NotifyChannelSetting[];
  templates?: Partial<Record<NotifyChannel, LocalizedText>>;
}
type StoredTypes = Record<string, StoredType>;

export interface NotifyTypeOut {
  id: string;
  code: number;
  recipient: 'client' | 'staff';
  name: LocalizedText;
  enabled: boolean;
  availableChannels: NotifyChannel[];
  channels: NotifyChannelSetting[];
  templates: Partial<Record<NotifyChannel, LocalizedText>>;
}

/**
 * Тип уведомления по-нашему (docs/backend/05 §3): включён/выключен + свой текст на каждый язык. Свой,
 * заметно более узкий словарь, чем Altegio-каталог из 88 типов в моке фронта — см. `kinds.ts` докстринг.
 * Хранится одной JSON-строкой на бизнес (тот же приём, что split-by-resource/online settings — F4,
 * BusinessSetting area+data), правится по одному типу за раз через merge.
 */
@Injectable()
export class NotifyTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(businessId: string): Promise<NotifyTypeOut[]> {
    const stored = await readStoredTypes(this.prisma, businessId);
    return NOTIFY_KINDS.map((def) => {
      const s = stored[def.kind];
      const enabled = s?.enabled ?? true;
      return {
        id: `${businessId}:${def.kind}`,
        code: def.code,
        recipient: def.recipient,
        name: { ru: def.kind, en: def.kind },
        enabled,
        availableChannels: ['push'],
        channels: s?.channels ?? [{ channel: 'push', scenario: enabled ? 'always' : 'off' }],
        templates: s?.templates ?? {},
      };
    });
  }

  async updateType(ctx: RequestContext, businessId: string, kind: string, patch: { enabled?: boolean; channels?: NotifyChannelSetting[] }): Promise<NotifyTypeOut> {
    const def = notifyKindOf(kind);
    if (!def) throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
      const data = (row?.data as StoredTypes | undefined) ?? {};
      const before = { ...(data[kind] ?? {}) };
      const next: StoredType = { ...before };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.channels) next.channels = patch.channels;
      data[kind] = next;
      await tx.businessSetting.upsert({
        where: { businessId_area: { businessId, area: AREA } },
        create: { businessId, area: AREA, data: J(data), updatedBy: ctx.member?.staffId },
        update: { data: J(data), version: { increment: 1 }, updatedBy: ctx.member?.staffId },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'notify_type', entityId: `${businessId}:${kind}`, businessId, before: R(before), after: R(next) });
    });
    return (await this.list(businessId)).find((t) => t.code === def.code)!;
  }

  async getTemplates(businessId: string, kind: string): Promise<Partial<Record<NotifyChannel, LocalizedText>>> {
    if (!notifyKindOf(kind)) throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
    const stored = await readStoredTypes(this.prisma, businessId);
    return stored[kind]?.templates ?? {};
  }

  /** Патч по каналу мержится ПОВЕРХ текущего — как updateType в моке, не перетирает другие языки того же канала */
  async updateTemplates(ctx: RequestContext, businessId: string, kind: string, patch: Partial<Record<NotifyChannel, Partial<LocalizedText>>>): Promise<Partial<Record<NotifyChannel, LocalizedText>>> {
    const def = notifyKindOf(kind);
    if (!def) throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
    let result: Partial<Record<NotifyChannel, LocalizedText>> = {};
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
      const data = (row?.data as StoredTypes | undefined) ?? {};
      const current = data[kind] ?? {};
      const templates = { ...(current.templates ?? {}) };
      for (const [channel, val] of Object.entries(patch) as [NotifyChannel, Partial<LocalizedText>][]) {
        const existing = templates[channel] ?? { ru: '' };
        templates[channel] = { ...existing, ...val, ru: val.ru ?? existing.ru };
      }
      data[kind] = { ...current, templates };
      result = templates;
      await tx.businessSetting.upsert({
        where: { businessId_area: { businessId, area: AREA } },
        create: { businessId, area: AREA, data: J(data), updatedBy: ctx.member?.staffId },
        update: { data: J(data), version: { increment: 1 }, updatedBy: ctx.member?.staffId },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'notify_template', entityId: `${businessId}:${kind}`, businessId, before: R({ templates: current.templates ?? {} }), after: R({ templates }) });
    });
    return result;
  }

  /** «Показать пример» (F-05-023) — рендер шаблона (свой или по умолчанию) на выдуманных данных */
  async preview(businessId: string, kind: string, localeRaw: string): Promise<{ text: string }> {
    const def = notifyKindOf(kind);
    if (!def) throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
    const locale: Locale = isLocale(localeRaw) ? localeRaw : 'ru';
    const templates = await this.getTemplates(businessId, kind);
    const sample = { service: 'Haircut', time: '18:00', place: 'Kaytsak Barbershop', client: 'Ани', staff: 'Ани' };
    const custom = templates.push?.[locale] ?? templates.push?.ru;
    return { text: custom ? renderTemplate(custom, sample) : t(locale, def.messageKey, sample) };
  }
}

function renderTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
}
