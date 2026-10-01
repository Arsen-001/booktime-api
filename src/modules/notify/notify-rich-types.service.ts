import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { TYPE_REGISTRY, typeDefByCode } from './notify-type-registry.js';
import { smsDefaultOf } from './notify-sms-defaults.js';
import type { NotifyChannel, NotifyClientGroup, NotifyRecipient, NotifyScenario, RegistryTypeConditions, TypeDef } from './notify-type-registry.js';

const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

export interface RichLocalizedText {
  ru: string;
  hy?: string;
  en?: string;
}
export interface RichChannelSetting {
  channel: NotifyChannel;
  scenario: NotifyScenario;
}
export interface RichEmailExtra {
  enabled: boolean;
  indent: boolean;
  text: string;
  imageUrl?: string;
  videoUrl?: string;
  linkUrl?: string;
  linkLabel?: string;
}

export interface NotificationTypeOut {
  id: string;
  code: number;
  recipient: NotifyRecipient;
  group?: NotifyClientGroup;
  name: RichLocalizedText;
  description: RichLocalizedText;
  enabled: boolean;
  availableChannels: NotifyChannel[];
  channels: RichChannelSetting[];
  templates: Partial<Record<NotifyChannel, RichLocalizedText>>;
  emailExtra?: RichEmailExtra;
  conditions?: RegistryTypeConditions;
  alwaysOn?: boolean;
  systemLocked?: boolean;
}

export interface TypePatch {
  enabled?: boolean;
  channels?: RichChannelSetting[];
  templates?: Partial<Record<NotifyChannel, Partial<RichLocalizedText>>>;
  emailExtra?: RichEmailExtra;
  conditions?: RegistryTypeConditions;
}

interface StoredOverride {
  enabled?: boolean;
  channels?: RichChannelSetting[];
  templates?: Partial<Record<NotifyChannel, RichLocalizedText>>;
  emailExtra?: RichEmailExtra;
  conditions?: RegistryTypeConditions;
}

function defaultOf(def: TypeDef, businessId: string): NotificationTypeOut {
  const template: RichLocalizedText = { ru: def.templateRu, en: def.templateEn, hy: def.templateHy };
  const templates: Partial<Record<NotifyChannel, RichLocalizedText>> = {};
  const smsShort = smsDefaultOf(def.code);
  def.availableChannels.forEach((channel) => {
    // 28.09: SMS — короткий текст (одна часть = 25 ֏), остальные каналы — полный
    templates[channel] = channel === 'sms' && smsShort ? { ...smsShort } : { ...template };
  });
  return {
    id: `nt_${businessId}_${def.code}`,
    code: def.code,
    recipient: def.recipient,
    group: def.group,
    name: { ru: def.nameRu, en: def.nameEn, hy: def.nameHy },
    description: { ru: def.descriptionRu, en: def.descriptionEn, hy: def.descriptionHy },
    enabled: def.enabledDefault,
    availableChannels: def.availableChannels,
    channels: def.availableChannels.map((channel) => ({ channel, scenario: def.defaultScenario[channel] ?? 'off' })),
    templates,
    emailExtra: def.availableChannels.includes('email') ? { enabled: false, indent: false, text: '' } : undefined,
    conditions: def.conditionsDefault ? { ...def.conditionsDefault } : undefined,
    alwaysOn: def.alwaysOn,
    systemLocked: def.systemLocked,
  };
}

/**
 * 28.09: сохранённая правка хранит все каналы разом — SMS-текст, равный прежнему полному тексту по умолчанию (или
 * пустой), читается как новый короткий; свой текст салона не трогаем (сравнение по каждому языку).
 */
function upgradeSms(templates: Partial<Record<NotifyChannel, RichLocalizedText>>, base: NotificationTypeOut): Partial<Record<NotifyChannel, RichLocalizedText>> {
  const short = smsDefaultOf(base.code);
  const def = typeDefByCode(base.code);
  const current = templates.sms;
  if (!short || !def || !current) return templates;
  const oldFull: Record<'ru' | 'en' | 'hy', string | undefined> = { ru: def.templateRu, en: def.templateEn, hy: def.templateHy };
  const pick = (lang: 'ru' | 'en' | 'hy'): string => (!current[lang] || current[lang] === oldFull[lang] ? short[lang] : (current[lang] as string));
  return { ...templates, sms: { ...current, ru: pick('ru'), en: pick('en'), hy: pick('hy') } };
}

function applyOverride(base: NotificationTypeOut, o: StoredOverride | undefined): NotificationTypeOut {
  if (!o) return base;
  return {
    ...base,
    enabled: o.enabled ?? base.enabled,
    // Канал, добавленный в реестр после сохранения правки (Telegram у типа 1, 01.10.2026), — со сценарием реестра
    channels: o.channels ? base.channels.map((c) => o.channels!.find((x) => x.channel === c.channel) ?? c) : base.channels,
    templates: o.templates ? upgradeSms(o.templates, base) : base.templates,
    emailExtra: o.emailExtra ?? base.emailExtra,
    conditions: o.conditions ?? base.conditions,
  };
}

/**
 * Каталог типов уведомлений ПОД экран (решение владельца 28.09, этап 21 «notify+integrations», попытка 3) —
 * реестр (`notify-type-registry.ts`, порт TYPE_REGISTRY фронта) + правка бизнеса поверх (`NotifyTypeOverride`,
 * одна строка на business+code, только тронутые поля). НЕ питает настоящую отправку (см. `notify-type-registry.ts`
 * докстринг) — это каталог настройки, как было на моке.
 */
@Injectable()
export class NotifyRichTypesService {
  constructor(private readonly prisma: PrismaService) {}

  private rowToOverride(row: { enabled: boolean | null; channels: unknown; templates: unknown; emailExtra: unknown; conditions: unknown }): StoredOverride {
    return {
      enabled: row.enabled ?? undefined,
      channels: (row.channels as RichChannelSetting[] | null) ?? undefined,
      templates: (row.templates as Partial<Record<NotifyChannel, RichLocalizedText>> | null) ?? undefined,
      emailExtra: (row.emailExtra as RichEmailExtra | null) ?? undefined,
      conditions: (row.conditions as RegistryTypeConditions | null) ?? undefined,
    };
  }

  async list(businessId: string): Promise<NotificationTypeOut[]> {
    const rows = await this.prisma.notifyTypeOverride.findMany({ where: { businessId } });
    const byCode = new Map(rows.map((r) => [r.code, this.rowToOverride(r)]));
    return TYPE_REGISTRY.map((def) => applyOverride(defaultOf(def, businessId), byCode.get(def.code)));
  }

  async get(businessId: string, code: number): Promise<NotificationTypeOut> {
    const def = typeDefByCode(code);
    if (!def) throw new ApiError('not_found', `Unknown notify type code: ${code}`);
    const row = await this.prisma.notifyTypeOverride.findUnique({ where: { businessId_code: { businessId, code } } });
    return applyOverride(defaultOf(def, businessId), row ? this.rowToOverride(row) : undefined);
  }

  async update(businessId: string, code: number, patch: TypePatch, updatedBy?: string): Promise<NotificationTypeOut> {
    const def = typeDefByCode(code);
    if (!def) throw new ApiError('not_found', `Unknown notify type code: ${code}`);
    const current = await this.get(businessId, code);
    const nextTemplates: Partial<Record<NotifyChannel, RichLocalizedText>> = { ...current.templates };
    if (patch.templates) {
      for (const [channel, val] of Object.entries(patch.templates) as [NotifyChannel, Partial<RichLocalizedText>][]) {
        const existing = nextTemplates[channel] ?? { ru: current.templates[channel]?.ru ?? '' };
        nextTemplates[channel] = { ...existing, ...val, ru: val.ru ?? existing.ru };
      }
    }
    const nextConditions = patch.conditions ? { ...current.conditions, ...patch.conditions } : current.conditions;
    const stored: StoredOverride = {
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      channels: patch.channels ?? current.channels,
      templates: nextTemplates,
      emailExtra: patch.emailExtra ?? current.emailExtra,
      conditions: nextConditions,
    };
    await this.prisma.notifyTypeOverride.upsert({
      where: { businessId_code: { businessId, code } },
      create: {
        businessId,
        code,
        enabled: stored.enabled ?? null,
        channels: J(stored.channels),
        templates: J(stored.templates),
        emailExtra: J(stored.emailExtra),
        conditions: J(stored.conditions),
        updatedBy,
      },
      update: {
        enabled: stored.enabled ?? null,
        channels: J(stored.channels),
        templates: J(stored.templates),
        emailExtra: J(stored.emailExtra),
        conditions: J(stored.conditions),
        updatedBy,
      },
    });
    return applyOverride(defaultOf(def, businessId), stored);
  }
}
