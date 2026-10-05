import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { isLocale, LOCALES, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { normalizePhone } from '../../common/phone.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { tgLocale } from '../telegram/telegram-links.js';
import { costOf, fillTemplate } from './notify-log-derive.js';
import { NotifyRichTypesService, type NotificationTypeOut, type RichLocalizedText } from './notify-rich-types.service.js';
import type { NotifyChannel } from './notify-type-registry.js';
import { enqueueClientNotification, enqueueOutbox } from './outbox.js';

/**
 * ⭐ Автоматические уведомления клиенту по каталогу типов (06.10.2026): «Клиент не пришёл» (75), «Зовём вернуться»
 * (72), «Спрашиваем впечатление» (6/20), «С днём рождения» (3), «Приглашение на повторный визит» / «Пора снова» (55).
 * Когда слать — решают задачи воркера (jobs/notify-client-auto.ts); здесь — общее «как»:
 *  · настройка бизнеса = реестр + NotifyTypeOverride (NotifyRichTypesService — тот же каталог, что видит экран):
 *    тип выключен — ничего; текст — шаблон бизнеса канала на языке получателя (нет — наш по умолчанию из реестра);
 *  · настройки клиента (ClientNotifyPref): выключил этот тип — ничего; выключил пуши / SMS — этот канал пропускаем;
 *  · канал по порядку: пуш (наше приложение, живой токен) → Telegram-бот на номере → SMS/WhatsApp провайдера бизнеса
 *    (сценарий SMS включён в типе и провайдер подключён, В-08) → «Не доставлено» в журнале отправок;
 *  · один раз: строка журнала отправок с ключом `auto:<событие>` («Отправляется»; итог — из очереди, notify-log-outbox.ts) ставится ДО отправки — второй проход задачи (или второй
 *    воркер) получает конфликт ключа и ничего не шлёт ни в какой канал. Очередь (notify_outbox) — свои ключи дубля.
 */

export type ClientAutoChannel = 'push' | 'telegram' | 'sms' | 'whatsapp';
export type ClientAutoOutcome = ClientAutoChannel | 'notDelivered' | 'duplicate' | 'off';

export interface ClientPrefs {
  disabledTypeCodes: number[];
  push: boolean;
  sms: boolean;
  marketingOptOut: boolean;
}

/** Настройки уведомлений клиентов (F-04-087…090) одной выборкой — нет строки → всё включено */
export async function clientPrefsOf(db: PrismaService, clientIds: string[]): Promise<Map<string, ClientPrefs>> {
  if (!clientIds.length) return new Map();
  const rows = await db.clientNotifyPref.findMany({ where: { clientId: { in: clientIds } } });
  return new Map(
    rows.map((r) => {
      const ch = (r.channels as { push?: boolean; sms?: boolean } | null) ?? {};
      return [r.clientId, { disabledTypeCodes: Array.isArray(r.disabledTypeCodes) ? (r.disabledTypeCodes as number[]) : [], push: ch.push !== false, sms: ch.sms !== false, marketingOptOut: Boolean(r.marketingOptOut) }];
    }),
  );
}

/** Каталог типов бизнеса с кэшем на проход задачи: один запрос на (бизнес, код) */
export class ClientTypeConfigs {
  private readonly svc: NotifyRichTypesService;
  private readonly cache = new Map<string, Promise<NotificationTypeOut>>();
  constructor(db: PrismaService) {
    this.svc = new NotifyRichTypesService(db);
  }
  get(businessId: string, code: number): Promise<NotificationTypeOut> {
    const key = `${businessId}:${code}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.svc.get(businessId, code);
      this.cache.set(key, p);
    }
    return p;
  }
}

function scenarioOn(type: NotificationTypeOut, channel: NotifyChannel): boolean {
  return (type.channels.find((c) => c.channel === channel)?.scenario ?? 'off') !== 'off';
}

/**
 * Telegram-бот — наш бесплатный канал для клиентов без приложения (F-00-120). У этих типов его нет в списке каналов
 * экрана, поэтому он разрешён, пока тип включён; если когда-нибудь появится и салон поставит «Не отправлять» — уважаем.
 */
function telegramOn(type: NotificationTypeOut): boolean {
  const c = type.channels.find((x) => x.channel === 'telegram');
  return !c || c.scenario !== 'off';
}

export type VarsByLocale = Record<Locale, Record<string, string>>;

/** Текст канала на всех языках: шаблон бизнеса (или реестра) с переменными; Telegram — текст пуша */
export function textsFor(type: NotificationTypeOut, channel: NotifyChannel, vars: VarsByLocale): Record<Locale, string> {
  const tpl: RichLocalizedText | undefined = type.templates[channel] ?? type.templates.push ?? type.templates.brandedApp;
  return Object.fromEntries(LOCALES.map((l) => [l, fillTemplate(tpl?.[l] || tpl?.ru || '', vars[l])])) as Record<Locale, string>;
}

export interface ClientAutoInput {
  businessId: string;
  businessName: string;
  type: NotificationTypeOut;
  /** Вид в очереди (kinds.ts) — по нему отправитель проверяет isKindEnabled и тихие часы */
  kind: string;
  client: { id: string | null; phone: string; locale: string | null };
  /** Человек нашего приложения (если есть) — пуш и лента */
  appUserId: string | null;
  prefs?: ClientPrefs;
  vars: VarsByLocale;
  /** Ключ события: `75:<запись>`, `3:<клиент>:<год>`… — один раз на событие */
  dedupe: string;
  /** Куда ведёт тап по пушу — путь сайта */
  url: string;
  inbox?: { kind: string; staffId?: string | null; bookingId?: string | null; params?: Record<string, unknown> };
  staffId?: string | null;
  bookingId?: string | null;
  /** Выключатели одной записи (окно записи → «Уведомления о визите») — только у уведомлений о конкретной записи */
  bookingOverride?: { pushEnabled?: boolean; telegramEnabled?: boolean; smsEnabled?: boolean } | null;
  now: Date;
}

export async function sendClientAuto(db: PrismaService, messenger: BusinessMessenger, input: ClientAutoInput): Promise<ClientAutoOutcome> {
  const { type, prefs, now } = input;
  if (!type.enabled) return 'off';
  if (prefs?.disabledTypeCodes.includes(type.code)) return 'off';
  const logKey = `auto:${input.dedupe}`;
  if (await db.notifyLogEntry.findUnique({ where: { dedupeKey: logKey }, select: { id: true } })) return 'duplicate';

  const ov = input.bookingOverride ?? null;
  const phone = normalizePhone(input.client.phone) ?? input.client.phone;
  const clientLocale: Locale = isLocale(input.client.locale) ? input.client.locale : 'ru';

  /** Строка журнала отправок — она же «захват» события: конфликт ключа = событие уже обработано */
  const claim = async (channel: string, status: 'sent' | 'sending' | 'notDelivered', texts: Record<Locale, string>, lang: Locale): Promise<boolean> => {
    const cost = status === 'notDelivered' ? { costAmd: 0, smsParts: undefined } : costOf(channel, texts[lang]);
    try {
      await db.notifyLogEntry.create({
        data: {
          id: newId('notifyLogEntry'),
          businessId: input.businessId,
          dedupeKey: logKey,
          sentAt: now,
          typeCode: type.code,
          typeLabel: { ...type.name } as Record<string, string>,
          channel,
          status,
          contact: phone.slice(0, 160),
          text: texts,
          clientId: input.client.id,
          staffId: input.staffId ?? null,
          bookingId: input.bookingId ?? null,
          sentLanguage: lang,
          costAmd: cost.costAmd,
          smsParts: cost.smsParts ?? null,
          source: 'service',
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false;
      throw err;
    }
  };
  const setStatus = (status: 'sent' | 'notDelivered') => db.notifyLogEntry.update({ where: { dedupeKey: logKey }, data: { status } });

  // 1. Пуш: тип шлёт в приложение, клиент не выключил пуши, у записи пуш не выключен, есть живой токен
  const pushOk = (scenarioOn(type, 'push') || scenarioOn(type, 'brandedApp')) && prefs?.push !== false && ov?.pushEnabled !== false;
  if (pushOk && input.appUserId) {
    const token = await db.pushToken.findFirst({ where: { userId: input.appUserId, app: 'client', invalidAt: null }, select: { id: true } });
    if (token) {
      const user = await db.user.findUnique({ where: { id: input.appUserId }, select: { locale: true } });
      const lang: Locale = isLocale(user?.locale) ? user.locale : clientLocale;
      const texts = textsFor(type, 'push', input.vars);
      // «Отправляется» — итог («Отправлено» / «Не доставлено») журнал возьмёт из очереди по тому же ключу (notify-log-outbox.ts)
      if (!(await claim('push', 'sending', texts, lang))) return 'duplicate';
      await enqueueClientNotification(db, {
        businessId: input.businessId,
        kind: input.kind,
        appUserId: input.appUserId,
        title: input.businessName,
        body: texts[lang],
        url: input.url,
        dedupeKey: `${logKey}:push`,
        meta: { typeCode: type.code, bookingId: input.bookingId ?? undefined },
        inbox: input.inbox ? { ...input.inbox, businessId: input.businessId } : undefined,
      });
      return 'push';
    }
  }

  // 2. Telegram-бот на номере клиента (бесплатно, клиентам без приложения)
  if (telegramOn(type) && ov?.telegramEnabled !== false && phone) {
    const links = await db.telegramLink.findMany({ where: { phone, blockedAt: null } });
    if (links.length) {
      const texts = textsFor(type, 'push', input.vars);
      if (!(await claim('telegram', 'sending', texts, tgLocale(links[0]!.languageCode)))) return 'duplicate';
      for (const link of links) {
        await enqueueOutbox(db, {
          businessId: input.businessId,
          app: 'telegram',
          kind: input.kind,
          recipientUserId: link.chatId,
          title: input.businessName,
          body: texts[tgLocale(link.languageCode)],
          url: input.url,
          dedupeKey: `${logKey}:tg:${link.chatId}`,
          meta: { typeCode: type.code, bookingId: input.bookingId ?? undefined },
        });
      }
      return 'telegram';
    }
  }

  // 3. SMS/WhatsApp провайдера бизнеса — сценарий SMS включён в типе, клиент не выключил SMS, провайдер подключён
  if (scenarioOn(type, 'sms') && prefs?.sms !== false && ov?.smsEnabled !== false && phone) {
    const setting = await db.businessSetting.findUnique({ where: { businessId_area: { businessId: input.businessId, area: 'notify-sms' } } });
    const conn = setting?.data as { connected?: boolean; channel?: 'sms' | 'whatsapp' } | undefined;
    if (conn?.connected) {
      const channel = conn.channel === 'whatsapp' ? 'whatsapp' : 'sms';
      const texts = textsFor(type, 'sms', input.vars);
      if (!(await claim(channel, 'sending', texts, clientLocale))) return 'duplicate';
      let delivered = false;
      try {
        delivered = (await messenger.send({ businessId: input.businessId, to: phone, text: texts[clientLocale], channel })).delivered;
      } catch (err) {
        logger.warn({ err, typeCode: type.code, businessId: input.businessId }, 'notify.client-auto: SMS/WhatsApp не отправлен');
      }
      await setStatus(delivered ? 'sent' : 'notDelivered');
      return delivered ? channel : 'notDelivered';
    }
  }

  // 4. Некуда — «Не доставлено» в журнале отправок, чтобы салон видел правду
  const texts = textsFor(type, 'push', input.vars);
  if (!(await claim('push', 'notDelivered', texts, clientLocale))) return 'duplicate';
  return 'notDelivered';
}

/** Люди нашего приложения по номерам (users.phone) — у карточки клиента appUserId есть только после записи из приложения */
export async function appUsersByPhone(db: PrismaService, phones: string[]): Promise<Map<string, string>> {
  const list = [...new Set(phones.filter(Boolean))];
  if (!list.length) return new Map();
  const users = await db.user.findMany({ where: { phone: { in: list } }, select: { id: true, phone: true } });
  return new Map(users.filter((u) => u.phone).map((u) => [u.phone!, u.id]));
}

/** Первое имя клиента — {clientName}, как журнал отправок (notify-log-derive.ts::clientVars) */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function localText(v: unknown, lang: Locale): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  const t = v as Partial<Record<Locale, string>>;
  return t[lang] || t.ru || '';
}
