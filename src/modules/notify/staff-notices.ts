import { isLocale, t, type Locale } from '../../common/i18n/i18n.js';
import type { MessageKey } from '../../common/i18n/messages.js';
import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';
import { fillTemplate } from './notify-log-derive.js';
import { defaultStaffPushOn, staffPrefsRichArea, type StaffNotifyEventRich } from './notify-more.service.js';
import { typeDefByCode, type NotifyScenario } from './notify-type-registry.js';
import { enqueueOutbox, type Db } from './outbox.js';

/**
 * Пуши сотрудникам (06.10.2026, docs/coverage/2026-10-06.md №2, №6, №9) — сверх «клиент записался/отменил/перенёс»
 * (bookings.service.ts::notifyStaff):
 *  · о действиях ПЕРСОНАЛА с записью мастера (F-05-045, F-05-050…053) — типы каталога экрана «Уведомления»:
 *    56 «Коллега создал запись» (администраторам), 57 «Вам назначили клиента», 42 «Вашу запись перенесли»,
 *    13 «Вашу запись отменили» (и удалили), 76 «Ваш клиент не пришёл» (мастеру); своё действие себе не шлём;
 *  · «заявка ждёт ответа» (F-00-067) — jobs/notify-staff-request-reminders.ts;
 *  · «пришёл · сумма / не пришёл» после визита (F-00-127) — jobs/notify-staff-visit-mark.ts.
 *
 * Чьи настройки уважаем (тот же порядок, что F-05-059):
 *  1. тип каталога (NotifyTypeOverride): выключен или канал «Приложение администратора» (adminApp) «Не отправлять» — нет;
 *     текст — шаблон этого канала бизнеса на языке получателя, не правили — текст каталога (что видно на экране, то уходит);
 *  2. вид в карточке сотрудника (`nsp:<staffId>`, F-05-055): «Отключено» — ничего; типы «Администратору» — только
 *     «Для администратора» или «На основе прав» у владельца/администратора;
 *  3. строка матрицы «событие × Push» (F-05-056) — по умолчанию пуш включён (notify-more.service.ts::defaultStaffPushOn);
 *  4. личный выключатель мастера (Staff.pushPrefs, F-05-060 / F-10-137);
 *  5. «Отправлять имя и номер телефона клиента» (F-05-057) снята — без имени клиента;
 *  6. вид очереди выключен (kinds.ts, isKindEnabled) — пропускает отправитель очереди.
 * Тихие часы: событийные пуши уходят сразу, как и существующие пуши персоналу; задачи-напоминания в тихие часы
 * не запускаются (см. сами задачи).
 */

export type StaffAudience = 'staff' | 'admin';

export interface StaffNoticeDef {
  kind: string;
  /** Тип каталога (notify-type-registry.ts) — его выключатель, канал adminApp и шаблон; нет — только наши настройки */
  typeCode?: number;
  audience: StaffAudience;
  /** Строка матрицы карточки сотрудника; нет — событие матрицей не управляется (неявка, отметка визита) */
  matrix?: StaffNotifyEventRich;
  /** Текст по умолчанию, когда у вида нет типа каталога (или для особого случая — передача другому мастеру) */
  messageKey: MessageKey;
}

export const STAFF_NOTICES = {
  colleagueBooked: { kind: 'staff_colleague_booked', typeCode: 56, audience: 'admin', matrix: 'createdByAdmin', messageKey: 'staff.colleagueBooked' },
  assigned: { kind: 'staff_assigned', typeCode: 57, audience: 'staff', matrix: 'createdByAdmin', messageKey: 'staff.assigned' },
  moved: { kind: 'staff_booking_moved', typeCode: 42, audience: 'staff', matrix: 'moved', messageKey: 'staff.bookingMoved' },
  reassigned: { kind: 'staff_booking_moved', audience: 'staff', matrix: 'moved', messageKey: 'staff.bookingReassigned' },
  cancelled: { kind: 'staff_booking_cancelled', typeCode: 13, audience: 'staff', matrix: 'cancelledByAdmin', messageKey: 'staff.bookingCancelled' },
  deleted: { kind: 'staff_booking_cancelled', typeCode: 13, audience: 'staff', matrix: 'deleted', messageKey: 'staff.bookingCancelled' },
  noShow: { kind: 'staff_client_no_show', typeCode: 76, audience: 'staff', messageKey: 'staff.clientNoShow' },
  requestReminderStaff: { kind: 'staff_request_reminder', audience: 'staff', matrix: 'createdByClient', messageKey: 'staff.requestReminder' },
  requestReminderAdmin: { kind: 'staff_request_reminder', audience: 'admin', matrix: 'createdByClient', messageKey: 'staff.requestReminder' },
  visitMark: { kind: 'staff_visit_mark', audience: 'staff', messageKey: 'staff.visitMark' },
} as const satisfies Record<string, StaffNoticeDef>;

/** Сотрудник-адресат: кто он и где его личные выключатели */
export interface StaffRecipient {
  id: string;
  businessId: string;
  userId: string | null;
  role: string;
  status: string;
  name?: string | null;
  pushPrefs?: unknown;
}

export const STAFF_RECIPIENT_SELECT = { id: true, businessId: true, userId: true, role: true, status: true, name: true, pushPrefs: true } as const;

const ADMIN_ROLES = new Set(['owner', 'admin']);

interface RichPrefs {
  view?: 'admin' | 'staff' | 'byAccess' | 'off';
  matrix?: Partial<Record<StaffNotifyEventRich, { push?: boolean }>>;
  sendClientContacts?: boolean;
}

interface TypeConfig {
  enabled: boolean;
  templates: Partial<Record<Locale, string>>;
}

/** Кэш на один проход (событие записи или проход задачи) — настройки бизнеса и сотрудников читаются по разу */
export class StaffNoticeContext {
  private readonly prefs = new Map<string, Promise<RichPrefs>>();
  private readonly types = new Map<string, Promise<TypeConfig>>();
  private readonly users = new Map<string, Promise<Locale>>();

  constructor(readonly db: Db) {}

  prefsOf(s: StaffRecipient): Promise<RichPrefs> {
    let p = this.prefs.get(s.id);
    if (!p) {
      p = this.db.businessSetting
        .findUnique({ where: { businessId_area: { businessId: s.businessId, area: staffPrefsRichArea(s.id) } } })
        .then((row) => ((row?.data as RichPrefs | null | undefined) ?? {}));
      this.prefs.set(s.id, p);
    }
    return p;
  }

  typeOf(businessId: string, code: number): Promise<TypeConfig> {
    const key = `${businessId}:${code}`;
    let p = this.types.get(key);
    if (!p) {
      p = this.db.notifyTypeOverride.findUnique({ where: { businessId_code: { businessId, code } } }).then((row) => typeConfigOf(code, row));
      this.types.set(key, p);
    }
    return p;
  }

  localeOf(userId: string): Promise<Locale> {
    let p = this.users.get(userId);
    if (!p) {
      p = this.db.user.findUnique({ where: { id: userId }, select: { locale: true } }).then((u) => (isLocale(u?.locale) ? u!.locale : 'ru'));
      this.users.set(userId, p);
    }
    return p;
  }
}

/** Тип каталога = реестр + правка бизнеса: включён ли и уходит ли в приложение администратора, свой текст канала */
export function typeConfigOf(code: number, row?: { enabled: boolean | null; channels: unknown; templates: unknown } | null): TypeConfig {
  const def = typeDefByCode(code);
  const stored = (row?.channels as { channel: string; scenario: NotifyScenario }[] | null | undefined) ?? [];
  const scenario = stored.find((c) => c.channel === 'adminApp')?.scenario ?? def?.defaultScenario.adminApp ?? 'off';
  const own = ((row?.templates as Record<string, Partial<Record<Locale, string>>> | null | undefined) ?? {}).adminApp ?? {};
  const templates: Partial<Record<Locale, string>> = {
    ru: own.ru?.trim() || def?.templateRu,
    en: own.en?.trim() || def?.templateEn,
    hy: own.hy?.trim() || def?.templateHy,
  };
  return { enabled: (row?.enabled ?? def?.enabledDefault ?? true) && scenario !== 'off', templates };
}

/** Пункты 2–4 докстринга: вид, строка матрицы, личный выключатель — без типа каталога */
export function staffPushAllowed(s: StaffRecipient, prefs: RichPrefs, def: Pick<StaffNoticeDef, 'audience' | 'matrix'>): boolean {
  if (!s.userId || s.status !== 'active') return false;
  const view = prefs.view ?? 'byAccess';
  if (view === 'off') return false;
  if (def.audience === 'admin' && !(view === 'admin' || (view === 'byAccess' && ADMIN_ROLES.has(s.role)))) return false;
  if (def.matrix) {
    const push = prefs.matrix?.[def.matrix]?.push ?? defaultStaffPushOn(def.matrix);
    if (!push) return false;
    const own = (s.pushPrefs as Record<string, unknown> | null | undefined)?.[def.matrix];
    if (own === false) return false;
  }
  return true;
}

export interface StaffNoticeVars {
  clientName: string;
  service: string;
  date: string;
  time: string;
  staff: string;
  deadline?: string;
}

/**
 * Поставить один пуш сотруднику, если все его настройки разрешают. `dedupeKey` — ключ события + адресат: повтор
 * прохода ничего не дублирует. Возвращает true, если строка в очереди появилась.
 */
export async function enqueueStaffNotice(
  ctx: StaffNoticeContext,
  input: { def: StaffNoticeDef; to: StaffRecipient; vars: StaffNoticeVars; dedupeKey: string; url?: string; meta?: Record<string, unknown>; sendAt?: Date; messageKey?: MessageKey },
): Promise<boolean> {
  const { def, to } = input;
  if (!to.userId) return false;
  const prefs = await ctx.prefsOf(to);
  if (!staffPushAllowed(to, prefs, def)) return false;
  const type = def.typeCode ? await ctx.typeOf(to.businessId, def.typeCode) : undefined;
  if (type && !type.enabled) return false;
  const locale = await ctx.localeOf(to.userId);
  const vars: Record<string, string> = { ...input.vars, deadline: input.vars.deadline ?? '' };
  if (!prefs.sendClientContacts && !isOwnClientView(def)) vars.clientName = '';
  const template = input.messageKey ? undefined : (type?.templates[locale] ?? type?.templates.ru);
  const raw = template ?? t(locale, input.messageKey ?? def.messageKey, vars);
  const body = tidy(template ? fillTemplate(raw, vars) : raw);
  return enqueueOutbox(ctx.db, {
    businessId: to.businessId,
    app: 'business',
    kind: def.kind,
    recipientUserId: to.userId,
    title: 'BookTime',
    body,
    url: input.url,
    dedupeKey: input.dedupeKey,
    sendAt: input.sendAt,
    // Журнал отправок: тип каталога и сотрудник-адресат (notify-log-outbox.ts); выключатель типа отправитель проверит ещё раз
    meta: { ...input.meta, staffId: to.id, ...(def.typeCode ? { typeCode: def.typeCode } : {}) },
  });
}

/**
 * F-05-057 «Отправлять имя и номер телефона клиента» — про уведомления о записях. Отметку визита и напоминание о заявке
 * мастер без имени не поймёт (их несколько подряд) — там имя остаётся: это его собственная запись, и «Ждут отметки» /
 * «Требует внимания» в кабинете показывают его же.
 */
function isOwnClientView(def: StaffNoticeDef): boolean {
  return def.kind === STAFF_NOTICES.visitMark.kind || def.kind === STAFF_NOTICES.requestReminderStaff.kind;
}

/** Убрать «хвосты» пустых переменных (нет имени клиента / услуги): «: , Маникюр», «(Анна, )» */
function tidy(text: string): string {
  return text
    .replace(/\s*[^\s.։:!?\n][^.։:!?\n]*[:՝]\s*(?=[.։])[.։]/g, '') // «Клиент: .» — подпись без значения
    .replace(/([:՝(])\s*,\s*/g, '$1 ')
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+([,.։)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Переменные текста записи: дата «ДД.ММ», время, услуга на языке получателя (русское имя, как остальные пуши персоналу) */
export function bookingVars(startAt: Date, tz: string, extra: { clientName?: string | null; service?: string | null; staff?: string | null }): StaffNoticeVars {
  const local = utcToLocal(startAt, tz || DEFAULT_TZ);
  return {
    clientName: extra.clientName ?? '',
    service: extra.service ?? '',
    date: `${local.slice(8, 10)}.${local.slice(5, 7)}`,
    time: local.slice(11, 16),
    staff: extra.staff ?? '',
  };
}

export function journalUrl(bookingId: string, startAt: Date, tz: string): string {
  return `/biz/journal?date=${utcToLocal(startAt, tz || DEFAULT_TZ).slice(0, 10)}&booking=${bookingId}`;
}

type LocalizedName = { ru?: string } | string | null | undefined;
export function serviceName(name: unknown): string {
  const n = name as LocalizedName;
  if (!n) return '';
  return typeof n === 'string' ? n : (n.ru ?? '');
}

// ─────────────────────────── действия персонала с записью (F-05-045, F-05-050…053) ───────────────────────────

export interface BookingLike {
  id: string;
  businessId: string;
  staffId: string;
  clientId: string | null;
  startAt: Date;
  status: string;
  services: unknown;
  groupEventId: string | null;
  visitorName?: string | null;
}

export interface BookingEventLike {
  id?: string;
  kind: string;
  toStatus?: string | null;
  prevStart?: string | null;
  prevStaffId?: string | null;
}

const CANCELLED = new Set(['cancelled_by_client', 'cancelled_by_master']);

/**
 * Вызывается из BookingsService.logEvents для каждого изменения записи — тем же списком событий, что ушёл в
 * booking_events. Действие клиента или онлайн-канала (`by === 'client'`) — не наше: это notifyStaff. Групповые
 * брони (участники события) — не шлём: у мастера одно событие, а не запись на каждого участника.
 * Прошлое (запись задним числом, перенос в прошлое) — молчим, кроме «не пришёл»: она всегда о прошлом.
 */
export async function notifyStaffOfStaffAction(db: Db, next: BookingLike, events: BookingEventLike[], by: string, tz: string, now = new Date()): Promise<number> {
  if (by === 'client' || next.groupEventId || !events.length) return 0;
  const future = next.startAt.getTime() > now.getTime();
  // Ночное продление серий и снятие заявок по сроку (by = 'system') — не «администратор записал/отменил»; неявка — да
  const byStaff = by !== 'system';
  const ctx = new StaffNoticeContext(db);
  const staffIds = new Set<string>([next.staffId]);
  for (const e of events) if (e.prevStaffId) staffIds.add(e.prevStaffId);
  const [staffRows, admins, client, service] = await Promise.all([
    db.staff.findMany({ where: { id: { in: [...staffIds] } }, select: STAFF_RECIPIENT_SELECT }),
    db.staff.findMany({ where: { businessId: next.businessId, role: { in: [...ADMIN_ROLES] }, status: 'active', userId: { not: null }, deletedAt: null }, select: STAFF_RECIPIENT_SELECT }),
    next.clientId ? db.client.findUnique({ where: { id: next.clientId }, select: { name: true } }) : Promise.resolve(null),
    firstServiceName(db, next.services),
  ]);
  const staffById = new Map(staffRows.map((s) => [s.id, s as StaffRecipient]));
  const master = staffById.get(next.staffId);
  const vars = bookingVars(next.startAt, tz, { clientName: client?.name ?? next.visitorName, service, staff: master?.name });
  const url = journalUrl(next.id, next.startAt, tz);
  const actorUserId = staffById.get(by)?.userId ?? admins.find((a) => a.id === by)?.userId ?? null;
  let sent = 0;
  const send = async (def: StaffNoticeDef, to: StaffRecipient | undefined, eventId: string) => {
    // Своё действие себе не шлём (тот же человек может быть в салоне двумя строками сотрудника — сверяем и аккаунт)
    if (!to || to.id === by || (actorUserId && to.userId === actorUserId)) return;
    const created = await enqueueStaffNotice(ctx, { def, to, vars, url, dedupeKey: `staff:${def.kind}:${eventId}:${to.userId}`, meta: { bookingId: next.id } });
    if (created) sent++;
  };

  for (const e of events) {
    const eventId = e.id ?? `${next.id}:${e.kind}`;
    if (e.kind === 'created') {
      if (!future || !byStaff) continue;
      await send(STAFF_NOTICES.assigned, master, eventId);
      // 56 — администраторам, кроме автора и самого мастера (ему ушло «Вам назначили»)
      for (const a of admins) if (a.id !== next.staffId) await send(STAFF_NOTICES.colleagueBooked, a as StaffRecipient, eventId);
    } else if (e.kind === 'moved') {
      if (!future || !byStaff) continue;
      if (e.prevStaffId && e.prevStaffId !== next.staffId) {
        await send(STAFF_NOTICES.assigned, master, eventId);
        await send(STAFF_NOTICES.reassigned, staffById.get(e.prevStaffId), eventId);
      } else {
        await send(STAFF_NOTICES.moved, master, eventId);
      }
    } else if (e.kind === 'status' && e.toStatus && CANCELLED.has(e.toStatus)) {
      if (future && byStaff) await send(STAFF_NOTICES.cancelled, master, eventId);
    } else if (e.kind === 'status' && e.toStatus === 'no_show') {
      await send(STAFF_NOTICES.noShow, master, eventId);
    } else if (e.kind === 'deleted') {
      if (future && byStaff) await send(STAFF_NOTICES.deleted, master, eventId);
    }
  }
  return sent;
}

export async function firstServiceName(db: Db, services: unknown): Promise<string> {
  const id = ((services as { serviceId?: string }[] | null | undefined) ?? [])[0]?.serviceId;
  if (!id) return '';
  const row = await db.service.findUnique({ where: { id }, select: { name: true } });
  return serviceName(row?.name);
}
