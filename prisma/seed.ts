import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/common/prisma.service.js';
import { norm } from '../src/common/text.js';
import { localToUtc, utcToLocalDate } from '../src/common/time/time.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { SYSTEM_ITEMS } from '../src/modules/finance/finance-catalog.service.js';
import { loadMockCore } from './seed/mock-core.js';

/**
 * Сид разработки (npx prisma db seed; его же зовёт prisma migrate reset). Строит те же данные, что демо фронта:
 * ядро мока (booking-platform/src/mock/seed) → таблицы сервера. Каждый этап дописывает свой раздел.
 *
 * Повторный запуск безопасен: строки с теми же id пропускаются (skipDuplicates / upsert) — так сид можно догнать
 * на рабочей базе после новой миграции, не стирая её.
 *
 * Только для разработки: пароли демо-входов известны (ниже), поэтому в production сид не запускается.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('seed: в production не запускается');
  process.exit(1);
}

/** Вход команды платформы для разработки (Р11): логин/пароль, код приходит на этот номер (заглушка — в лог) */
export const DEV_PLATFORM = { login: 'platform', password: 'booktime-dev', phone: '+37400199990', name: 'Команда BookTime' };

/** id человека для сотрудника мока: мастер/владелец/админ — это люди (users), сотрудник ссылается на них */
export const userIdOfStaff = (staffId: string) => `au_${staffId}`;

/** Токен приглашения разработки: ссылка /biz/onboarding/invite/<токен> для приглашённых в моке */
export const devInviteToken = (staffId: string) => `dev-invite-${staffId}`.padEnd(20, '0');

const prisma = new PrismaService();
const core = loadMockCore();
const t0 = Date.now();
const now = new Date();
const localDate = (s?: string) => (s ? new Date(`${s.length === 10 ? `${s}T12:00` : s}:00Z`) : now);
const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const local = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? localToUtc(s) : now);
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

type Rec = Record<string, unknown>;
const S = (v: unknown) => (typeof v === 'string' ? v : undefined);

// ─────────── этап 2: люди ───────────
// Клиенты приложения (AppUser мока) — с теми же id, что во фронте, чтобы экраны клиента видели те же данные
const byPhone = new Map<string, string>();
const users: { id: string; phone: string | null; name: string; locale: string; createdAt: Date }[] = [];
const profiles: { userId: string; gender: string; birthday: string | null; district: string | null; consentAt: Date; consentVersion: string }[] = [];

for (const u of core.appUsers) {
  byPhone.set(u.phone, u.id);
  users.push({ id: u.id, phone: u.phone, name: u.name, locale: u.locale ?? 'ru', createdAt: localDate(u.createdAt) });
  profiles.push({
    userId: u.id,
    gender: u.gender ?? 'unknown',
    birthday: u.birthday ?? null,
    district: u.district ?? null,
    consentAt: localDate(u.createdAt),
    consentVersion: '2026-09-draft',
  });
}
// Сотрудники мока — тоже люди (у мастера салона и владельца свой вход по номеру, F-00-033)
for (const s of core.staff) {
  if (s.phone && byPhone.has(s.phone)) continue; // тот же номер — тот же человек (F-00-045)
  const id = userIdOfStaff(s.id);
  if (s.phone) byPhone.set(s.phone, id);
  users.push({ id, phone: s.phone ?? null, name: s.name, locale: 'ru', createdAt: now });
}
const personOf = (s: { id: string; phone?: string }) => (s.phone && byPhone.get(s.phone)) || userIdOfStaff(s.id);
// Команда платформы
const platformUserId = 'au_platform';
users.push({ id: platformUserId, phone: DEV_PLATFORM.phone, name: DEV_PLATFORM.name, locale: 'ru', createdAt: now });

await prisma.user.createMany({ data: users.map((u) => ({ ...u, createdBy: 'seed', updatedBy: 'seed' })), skipDuplicates: true });
await prisma.appProfile.createMany({ data: profiles, skipDuplicates: true });

// ─────────── этап 3: сети, бизнесы, филиалы, сотрудники, должности, приглашения ───────────
const staffRecs = core.staff as unknown as Rec[];
const staffById = new Map(core.staff.map((s) => [s.id, s]));
const networks = (core.networks ?? []) as Rec[];
for (const n of networks) {
  const owner = staffById.get(String(n.ownerStaffId));
  await prisma.network.upsert({
    where: { id: String(n.id) },
    update: {},
    create: {
      id: String(n.id),
      name: String(n.name),
      ownerUserId: owner ? personOf(owner) : platformUserId,
      ownerStaffId: owner?.id ?? null,
      mainBusinessId: S(n.mainBusinessId) ?? (n.businessIds as string[])[0] ?? null,
      createdAt: local(S(n.createdAt)),
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  });
}

const businesses = core.businesses as unknown as Rec[];
await prisma.business.createMany({
  skipDuplicates: true,
  data: businesses.map((b) => ({
    id: String(b.id),
    kind: String(b.kind),
    name: String(b.name),
    slug: String(b.slug),
    sphereIds: (b.sphereIds ?? []) as Prisma.InputJsonValue,
    networkId: S(b.networkId) ?? null,
    ownerStaffId: S(b.ownerStaffId) ?? null,
    phone: String(b.phone ?? ''),
    description: J(b.description),
    logoUrl: S(b.logoUrl) ?? null,
    photos: (b.photos ?? []) as Prisma.InputJsonValue,
    status: String(b.status ?? 'active'),
    forbidHomeBookingsDuringShift: Boolean(b.forbidHomeBookingsDuringShift),
    socials: J(b.socials),
    bookingRules: J(b.bookingRules),
    brandName: S(b.brandName) ?? null,
    createdAt: local(S(b.createdAt)),
    createdBy: 'seed',
    updatedBy: 'seed',
  })),
});

const locations = (core.locations ?? []) as Rec[];
await prisma.location.createMany({
  skipDuplicates: true,
  data: locations.map((l, i) => {
    const coords = l.coords as { lat: number; lng: number } | undefined;
    return {
      id: String(l.id),
      businessId: String(l.businessId),
      name: l.name as Prisma.InputJsonValue,
      address: (l.address ?? { ru: '' }) as Prisma.InputJsonValue,
      district: String(l.district ?? 'kentron'),
      yandexMapsUrl: S(l.yandexMapsUrl) ?? null,
      lat: coords ? coords.lat.toFixed(6) : null,
      lng: coords ? coords.lng.toFixed(6) : null,
      phone: S(l.phone) ?? null,
      extraPhones: J(l.extraPhones),
      hoursText: S(l.hoursText) ?? null,
      openHours: J(l.openHours),
      journalKind: S(l.journalKind) ?? null,
      tz: S(l.timezone) ?? 'Asia/Yerevan',
      sortOrder: i,
      createdBy: 'seed',
      updatedBy: 'seed',
    };
  }),
});

// Должности — из имён на сотрудниках (как срез staff фронта), для всех бизнесов
const positionIdOf = new Map<string, string>(); // `${businessId}|${ru}` → id
const positions: Prisma.PositionCreateManyInput[] = [];
for (const b of businesses) {
  const seen = new Map<string, Rec>();
  for (const s of staffRecs) {
    const ru = (s.position as { ru?: string } | undefined)?.ru;
    if (s.businessId === b.id && ru && !seen.has(ru)) seen.set(ru, s.position as Rec);
  }
  let idx = 0;
  for (const [ru, name] of seen) {
    const id = `stpos_${String(b.id).replace(/^biz_/, '')}_${idx}`.slice(0, 32);
    positionIdOf.set(`${b.id}|${ru}`, id);
    positions.push({ id, businessId: String(b.id), name: name as Prisma.InputJsonValue, nameNorm: norm(ru), sortOrder: idx, createdBy: 'seed', updatedBy: 'seed' });
    idx++;
  }
}
await prisma.position.createMany({ data: positions, skipDuplicates: true });

const orderInBiz = new Map<string, number>();
const firedLongAgo = new Date(now.getTime() - 40 * 86_400_000);
await prisma.staff.createMany({
  skipDuplicates: true,
  data: staffRecs.map((s) => {
    const businessId = String(s.businessId);
    const order = orderInBiz.get(businessId) ?? 0;
    orderInBiz.set(businessId, order + 1);
    const status = String(s.status);
    const role = String(s.role);
    const ru = (s.position as { ru?: string } | undefined)?.ru;
    return {
      id: String(s.id),
      businessId,
      // Приглашённый ещё не принял — человека у карточки нет (F-00-042)
      userId: status === 'invited' ? null : personOf(s as { id: string; phone?: string }),
      name: String(s.name),
      phone: S(s.phone) ?? '',
      email: S(s.email) ?? null,
      role,
      roleTemplateId: role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : 'specialist',
      status,
      position: J(s.position),
      positionId: ru ? (positionIdOf.get(`${businessId}|${ru}`) ?? null) : null,
      specialty: J(s.specialty),
      sphereIds: (s.sphereIds ?? []) as Prisma.InputJsonValue,
      avatarUrl: S(s.avatarUrl) ?? null,
      bio: J(s.bio),
      photos: (s.photos ?? []) as Prisma.InputJsonValue,
      materials: (s.materials ?? []) as Prisma.InputJsonValue,
      workplaces: (s.workplaces ?? []) as Prisma.InputJsonValue,
      homeAddress: S(s.homeAddress) ?? null,
      homeDistrict: S(s.homeDistrict) ?? null,
      visitDistricts: J(s.visitDistricts),
      accepts: String(s.accepts ?? 'all'),
      calendarVisibility: String(s.calendarVisibility ?? 'all'),
      calendarMode: String(s.calendarMode ?? 'free'),
      confirmMode: String(s.confirmMode ?? 'manual'),
      colorIndex: Number(s.colorIndex ?? 1),
      serviceIds: (s.serviceIds ?? []) as Prisma.InputJsonValue,
      callHours: J(s.callHours),
      hiredAt: S(s.hiredAt) ?? utcToLocalDate(now),
      onlineBookingEnabled: s.onlineBookingEnabled !== false,
      hiddenInJournal: Boolean(s.hiddenInJournal),
      assistantOnly: Boolean(s.assistantOnly),
      journalMarkupMin: typeof s.journalMarkupMin === 'number' ? s.journalMarkupMin : null,
      prepayment: J(s.prepayment),
      bookingRules: J(s.bookingRules),
      contacts: J(s.contacts),
      sortOrder: order,
      // Отключённый сотрудник — доступ выключен (F-10-031); остальные — как в моке
      accessEnabled: status !== 'disabled',
      firedOn: status === 'fired' ? utcToLocalDate(firedLongAgo) : null,
      firedAt: status === 'fired' ? firedLongAgo : null,
      createdBy: 'seed',
      updatedBy: 'seed',
    };
  }),
});
await prisma.staffLocation.createMany({
  skipDuplicates: true,
  data: staffRecs.flatMap((s) => ((s.locationIds ?? []) as string[]).map((locationId) => ({ staffId: String(s.id), locationId }))),
});

const invited = staffRecs.filter((s) => s.status === 'invited');
for (const s of invited) {
  const tokenHash = sha(devInviteToken(String(s.id)));
  await prisma.staffInvite.upsert({
    where: { tokenHash },
    update: {},
    create: {
      id: `stinv_${String(s.id).replace(/^st_/, '')}`.slice(0, 32),
      businessId: String(s.businessId),
      staffId: String(s.id),
      role: s.role === 'admin' ? 'admin' : 'master',
      phone: S(s.phone) ?? null,
      tokenHash,
      expiresAt: new Date(now.getTime() + 14 * 86_400_000),
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  });
}

// ─────────── этап 2: входы (после сотрудников — внешний ключ staff_logins.staff_id) ───────────
// Логины администраторов (F-00-034): пароль разработки = логин → первый вход просит сменить (как в моке)
const admins = core.staff.filter((s) => s.role === 'admin' && s.login);
for (const s of admins) {
  const login = s.login!.toLowerCase();
  const id = `sl_${s.id}`.slice(0, 32);
  const exists = await prisma.staffLogin.findUnique({ where: { id } });
  if (exists) {
    // Логины, созданные до этапа 3, — привязать к сотруднику
    if (!exists.staffId) await prisma.staffLogin.update({ where: { id }, data: { staffId: s.id, businessId: s.businessId } });
    continue;
  }
  await prisma.staffLogin.create({
    data: {
      id,
      login,
      passwordHash: await hashPassword(login),
      userId: personOf(s),
      staffId: s.id,
      businessId: s.businessId,
      mustChangePassword: true,
      disabledAt: s.status === 'disabled' || s.status === 'fired' ? now : null,
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  });
}
if (!(await prisma.platformMember.findUnique({ where: { id: 'pm_platform' } }))) {
  await prisma.platformMember.create({
    data: {
      id: 'pm_platform',
      login: DEV_PLATFORM.login,
      passwordHash: await hashPassword(DEV_PLATFORM.password),
      userId: platformUserId,
      role: 'admin',
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  });
}

// ─────────── этап 4: каталог — категории, услуги (включая пакеты «Комплекс»), ресурсы ───────────
const categoriesRaw = (core.serviceCategories ?? []) as Rec[];
await prisma.serviceCategory.createMany({
  skipDuplicates: true,
  data: categoriesRaw.map((c) => ({
    id: String(c.id),
    businessId: String(c.businessId),
    name: c.name as Prisma.InputJsonValue,
    sortOrder: Number(c.order ?? 0),
    createdBy: 'seed',
    updatedBy: 'seed',
  })),
});

const servicesRaw = (core.services ?? []) as Rec[];
await prisma.service.createMany({
  skipDuplicates: true,
  data: servicesRaw.map((s) => ({
    id: String(s.id),
    businessId: String(s.businessId),
    categoryId: String(s.categoryId),
    sphereId: String(s.sphereId),
    name: s.name as Prisma.InputJsonValue,
    description: J(s.description),
    kind: String(s.kind ?? 'individual'),
    durationMin: Number(s.durationMin ?? 0),
    durationMax: typeof s.durationMax === 'number' ? s.durationMax : null,
    priceMin: BigInt(Math.trunc(Number(s.priceMin ?? 0))),
    priceMax: typeof s.priceMax === 'number' ? BigInt(Math.trunc(s.priceMax)) : null,
    bufferAfterMin: typeof s.bufferAfterMin === 'number' ? s.bufferAfterMin : null,
    repeatIntervalDays: typeof s.repeatIntervalDays === 'number' ? s.repeatIntervalDays : null,
    capacity: typeof s.capacity === 'number' ? s.capacity : null,
    photos: (s.photos ?? []) as Prisma.InputJsonValue,
    materials: (s.materials ?? []) as Prisma.InputJsonValue,
    staffIds: (s.staffIds ?? []) as Prisma.InputJsonValue,
    workplaces: (s.workplaces ?? []) as Prisma.InputJsonValue,
    onlineBookable: s.onlineBookable !== false,
    active: s.active !== false,
    order: BigInt(Math.trunc(Number(s.order ?? 0))),
    shadeChoice: S(s.shadeChoice) ?? null,
    servicePackage: J(s.servicePackage),
    createdBy: 'seed',
    updatedBy: 'seed',
  })),
});

const resourcesRaw = (core.resources ?? []) as Rec[];
await prisma.resource.createMany({
  skipDuplicates: true,
  data: resourcesRaw.map((r) => ({
    id: String(r.id),
    businessId: String(r.businessId),
    locationId: String(r.locationId),
    name: r.name as Prisma.InputJsonValue,
    kind: String(r.kind ?? 'other'),
    instances: (r.instances ?? []) as Prisma.InputJsonValue,
    serviceIds: (r.serviceIds ?? []) as Prisma.InputJsonValue,
    active: r.active !== false,
    createdBy: 'seed',
    updatedBy: 'seed',
  })),
});

// ─────────── этап 5: клиенты / CRM ───────────
// seedCore() отдаёт только ядро (CoreData) — профильные поля мока (скидка, класс, «Оплачено» сверх визитов
// и т.п.) живут в area-срезе браузера, а не в этом снимке, поэтому сеются только поля ядра; остальное — 0/null,
// как и у настоящего клиента, заведённого через API без формы (см. clients.service.ts createClient).
const clientsRaw = (core.clients ?? []) as Rec[];
await prisma.client.createMany({
  skipDuplicates: true,
  data: clientsRaw.map((c) => ({
    id: String(c.id),
    businessId: String(c.businessId),
    phone: String(c.phone),
    name: String(c.name),
    gender: String(c.gender ?? 'unknown'),
    birthday: S(c.birthday) ?? null,
    email: S(c.email) ?? null,
    note: S(c.note) ?? null,
    tags: (c.tags ?? []) as Prisma.InputJsonValue,
    appUserId: S(c.appUserId) ?? null,
    noShowCount: Number(c.noShowCount ?? 0),
    blocked: typeof c.blocked === 'boolean' ? c.blocked : null,
    source: 'manual',
    deletedAt: S(c.deletedAt) ? localToUtc(String(c.deletedAt).slice(0, 16)) : null,
    createdAt: local(S(c.createdAt)),
    createdBy: 'seed',
    updatedBy: 'seed',
  })),
});

// ─────────── этап 6: график, отметки, правила окон, занятость (busy_blocks) ───────────
// Графики и отметки — из ядра мока; шаблоны, история, правила слотов, настройки — из среза schedule (areaSchedule).
// Записей на сервере ещё нет (этап 7), но их ЗАНЯТОСТЬ уже нужна окнам: busy_blocks сеются из записей мока с теми же
// id (source=booking) — этап 7 заведёт таблицу записей с этими id и продолжит писать занятость через occupy.ts.
{
  const TZ = 'Asia/Yerevan';
  const schedulesRaw = (core.schedules ?? []) as Rec[];
  const marksRaw = (core.calendarMarks ?? []) as Rec[];
  const bookingsRaw = (core.bookings ?? []) as Rec[];
  const eventsRaw = (core.groupEvents ?? []) as Rec[];
  const area = ((core as Rec).areaSchedule ?? {}) as Rec;
  const staffBiz = new Map(core.staff.map((s) => [s.id, s.businessId]));
  const staffPerson = new Map(core.staff.map((s) => [s.id, s.status === 'invited' ? s.id : personOf(s)]));
  const servicesById = new Map(((core.services ?? []) as Rec[]).map((s) => [String(s.id), s]));
  const resourcesById = new Map(((core.resources ?? []) as Rec[]).map((r) => [String(r.id), r]));
  const atLocal = (dt: string, addMin = 0) => new Date(localToUtc(dt, TZ).getTime() + addMin * 60000);

  await prisma.workSchedule.createMany({
    skipDuplicates: true,
    data: schedulesRaw
      .filter((s) => staffBiz.has(String(s.staffId)))
      .map((s) => ({
        id: String(s.id),
        businessId: staffBiz.get(String(s.staffId))!,
        staffId: String(s.staffId),
        locationId: String(s.locationId),
        workplace: String(s.workplace ?? 'salon'),
        week: (s.week ?? {}) as Prisma.InputJsonValue,
        openUntil: S(s.openUntil) ?? null,
        createdBy: 'seed',
        updatedBy: 'seed',
      })),
  });
  const dayRows = schedulesRaw.flatMap((s) =>
    Object.entries((s.overrides ?? {}) as Record<string, unknown>).map(([date, hours]) => ({
      scheduleId: String(s.id),
      date,
      businessId: staffBiz.get(String(s.staffId))!,
      staffId: String(s.staffId),
      hours: hours as Prisma.InputJsonValue,
    })),
  );
  await prisma.scheduleDay.createMany({ skipDuplicates: true, data: dayRows.filter((d) => d.businessId) });

  await prisma.calendarMark.createMany({
    skipDuplicates: true,
    data: marksRaw
      .filter((m) => staffBiz.has(String(m.staffId)))
      .map((m) => ({
        id: String(m.id),
        businessId: staffBiz.get(String(m.staffId))!,
        staffId: String(m.staffId),
        date: String(m.date),
        fromTime: String(m.from),
        toTime: String(m.to),
        kind: String(m.kind),
        workplace: S(m.workplace) ?? null,
        note: S(m.note) ?? null,
        createdBy: 'seed',
      })),
  });

  // Занятость: записи (кроме отменённых и удалённых), групповые события, отметки «занят».
  // Повторный запуск: блоки источника, уже лежащие в базе, не дублируются.
  const have = new Set((await prisma.busyBlock.findMany({ select: { sourceId: true } })).map((b) => b.sourceId));
  const blocks: Prisma.BusyBlockCreateManyInput[] = [];
  const resBusy: Prisma.ResourceBusyCreateManyInput[] = [];
  const bufferOf = (lines: Rec[]) => Math.max(0, ...lines.map((l) => Number(servicesById.get(String(l.serviceId))?.bufferAfterMin ?? 0)));
  const labelOf = (w: unknown) => (w === 'home' ? 'home' : w === 'visit' ? 'visit' : 'salon');
  let n = 0;
  const bid = () => `bb_seed${String(++n).padStart(6, '0')}`;
  for (const b of bookingsRaw) {
    const status = String(b.status);
    if (b.deletedAt || status === 'cancelled_by_client' || status === 'cancelled_by_master') continue;
    if (have.has(String(b.id))) continue;
    const staffId = String(b.staffId);
    if (!staffBiz.has(staffId)) continue;
    const lines = (b.services ?? []) as Rec[];
    const dur = Number(b.durationMin ?? 0);
    const start = atLocal(String(b.start));
    const serviceEnd = atLocal(String(b.start), dur);
    const end = atLocal(String(b.start), dur + bufferOf(lines));
    const prepayment = (b.prepayment ?? null) as Rec | null;
    const holdUntil = status === 'awaiting_prepayment' && prepayment && !prepayment.paid && S(prepayment.holdUntil) ? atLocal(String(prepayment.holdUntil)) : null;
    blocks.push({
      id: bid(),
      personKey: staffPerson.get(staffId)!,
      staffId,
      businessId: String(b.businessId),
      locationId: S(b.locationId) ?? null,
      workplace: S(b.workplace) ?? null,
      startAt: start,
      endAt: end,
      serviceEndAt: serviceEnd,
      source: 'booking',
      sourceId: String(b.id),
      visibilityLabel: labelOf(b.workplace),
      noShow: status === 'no_show',
      holdUntil,
    });
    for (const rid of (b.resourceIds ?? []) as string[]) {
      if (!resourcesById.has(rid)) continue;
      resBusy.push({ id: `rbz_seed${String(resBusy.length + 1).padStart(6, '0')}`, resourceId: rid, businessId: String(b.businessId), startAt: start, endAt: end, source: 'booking', sourceId: String(b.id), noShow: status === 'no_show', holdUntil });
    }
  }
  for (const e of eventsRaw) {
    if (String(e.status) !== 'scheduled' || have.has(String(e.id))) continue;
    const staffId = String(e.staffId);
    if (!staffBiz.has(staffId)) continue;
    const dur = Number(e.durationMin ?? 0);
    const buf = Number(servicesById.get(String(e.serviceId))?.bufferAfterMin ?? 0);
    blocks.push({
      id: bid(),
      personKey: staffPerson.get(staffId)!,
      staffId,
      businessId: String(e.businessId),
      locationId: S(e.locationId) ?? null,
      workplace: 'salon',
      startAt: atLocal(String(e.start)),
      endAt: atLocal(String(e.start), dur + buf),
      serviceEndAt: atLocal(String(e.start), dur),
      source: 'group_event',
      sourceId: String(e.id),
      visibilityLabel: 'salon',
    });
  }
  const dayStart = (date: string) => localToUtc(`${date}T00:00`, TZ);
  const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (const m of marksRaw) {
    if (String(m.kind) !== 'busy' || have.has(String(m.id)) || !staffBiz.has(String(m.staffId))) continue;
    const base = dayStart(String(m.date)).getTime();
    const staffId = String(m.staffId);
    blocks.push({
      id: bid(),
      personKey: staffPerson.get(staffId)!,
      staffId,
      businessId: staffBiz.get(staffId)!,
      workplace: S(m.workplace) ?? null,
      startAt: new Date(base + hm(String(m.from)) * 60000),
      endAt: new Date(base + hm(String(m.to)) * 60000),
      serviceEndAt: new Date(base + hm(String(m.to)) * 60000),
      source: 'mark_busy',
      sourceId: String(m.id),
      visibilityLabel: 'busy',
    });
  }
  if (have.size === 0 || blocks.length) {
    for (let i = 0; i < blocks.length; i += 1000) await prisma.busyBlock.createMany({ data: blocks.slice(i, i + 1000), skipDuplicates: true });
    for (let i = 0; i < resBusy.length; i += 1000) await prisma.resourceBusy.createMany({ data: resBusy.slice(i, i + 1000), skipDuplicates: true });
  }
  await prisma.personLock.createMany({ skipDuplicates: true, data: [...new Set(blocks.map((b) => b.personKey))].map((personKey) => ({ personKey })) });

  // Срез schedule: шаблоны, история, правила слотов, настройки
  const templates = Object.values((area.templates ?? {}) as Record<string, Rec[]>).flat();
  await prisma.scheduleTemplate.createMany({
    skipDuplicates: true,
    data: templates.map((t) => ({
      id: String(t.id),
      businessId: String(t.businessId),
      name: String(t.name ?? ''),
      kind: String(t.kind),
      weekdays: J(t.weekdays),
      shiftWork: typeof t.shiftWork === 'number' ? t.shiftWork : null,
      shiftOff: typeof t.shiftOff === 'number' ? t.shiftOff : null,
      hours: (t.hours ?? []) as Prisma.InputJsonValue,
      createdBy: 'seed',
    })),
  });
  const history = (area.history ?? []) as Rec[];
  const bizOfStaff = (ids: unknown) => staffBiz.get(String(((ids as string[]) ?? [])[0] ?? '')) ?? null;
  await prisma.scheduleHistory.createMany({
    skipDuplicates: true,
    data: history
      .map((h) => ({ h, businessId: bizOfStaff(h.targetStaffIds) ?? (h.actorStaffId ? staffBiz.get(String(h.actorStaffId)) : undefined) }))
      .filter((x) => x.businessId)
      .map(({ h, businessId }) => ({
        id: String(h.id),
        businessId: businessId!,
        at: local(S(h.at)),
        action: String(h.action),
        targetStaffIds: (h.targetStaffIds ?? []) as Prisma.InputJsonValue,
        dates: (h.dates ?? []) as Prisma.InputJsonValue,
        summary: String(h.summary ?? ''),
        details: J(h.details),
        actorName: String(h.actorName ?? ''),
        actorStaffId: S(h.actorStaffId) ?? null,
      })),
  });
  const locBiz = new Map(((core.locations ?? []) as Rec[]).map((l) => [String(l.id), String(l.businessId)]));
  const ruleSets = Object.entries((area.slotRules ?? {}) as Record<string, unknown>).map(([key, rules]) => {
    const [scope, scopeId] = key.split(':') as [string, string];
    return { scope, scopeId, businessId: scope === 'location' ? locBiz.get(scopeId) : staffBiz.get(scopeId), rules: rules as Prisma.InputJsonValue };
  });
  await prisma.onlineSlotRuleSet.createMany({ skipDuplicates: true, data: ruleSets.filter((r) => r.businessId).map((r) => ({ ...r, businessId: r.businessId! })) });
  // Настройки раздела: «Любой специалист» по бизнесу, «Пропуск выбора» по сотруднику (как в срезе)
  const any = (area.anySpecialistAllowed ?? {}) as Record<string, boolean>;
  const skip = (area.skipStaffSelection ?? {}) as Record<string, boolean>;
  for (const b of core.businesses) {
    const data = {
      anySpecialistAllowed: any[b.id] ?? false,
      allowOnlineOverNoShow: true,
      planningPeriodYears: Number(((area.planningPeriodYears ?? {}) as Record<string, number>)[b.id] ?? 1),
      notifyMasterOnScheduleChange: false,
      skipStaffSelection: Object.fromEntries(core.staff.filter((s) => s.businessId === b.id && skip[s.id]).map((s) => [s.id, true])),
      historyLimitDays: {},
      includeInFillRate: {},
      googleCalendar: {},
    };
    await prisma.businessSetting.upsert({
      where: { businessId_area: { businessId: b.id, area: 'schedule' } },
      create: { businessId: b.id, area: 'schedule', data },
      update: {},
    });
  }
  console.log(
    `seed: график — графиков ${schedulesRaw.length}, дней-исключений ${dayRows.length}, отметок ${marksRaw.length}, ` +
      `занятости ${blocks.length} (ресурсы ${resBusy.length}), шаблонов ${templates.length}, правил ${ruleSets.length}`,
  );
}

// ─────────── этап 7: записи, групповые события, настройки журнала, лист ожидания ───────────
// Записи мока — с теми же id (их занятость уже лежит в busy_blocks с этапа 6). Участники групповых событий время
// мастера не держат (его держит само событие) — их блоки с этапа 6 гасятся.
{
  const TZ = 'Asia/Yerevan';
  const bookingsRaw = (core.bookings ?? []) as Rec[];
  const eventsRaw = (core.groupEvents ?? []) as Rec[];
  const staffIds = new Set(core.staff.map((s) => s.id));
  const atLocal = (dt: string) => localToUtc(dt, TZ);
  const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60000);
  const seedNow = Date.now();
  const rows: Prisma.BookingCreateManyInput[] = [];
  for (const b of bookingsRaw) {
    if (!staffIds.has(String(b.staffId))) continue;
    const start = atLocal(String(b.start));
    const dur = Number(b.durationMin ?? 0);
    const status = String(b.status);
    const online = ['app', 'link', 'widget'].includes(String(b.source));
    const prepayment = (b.prepayment ?? null) as Rec | null;
    const holdUntil = status === 'awaiting_prepayment' && prepayment && !prepayment.paid && S(prepayment.holdUntil) ? atLocal(String(prepayment.holdUntil)) : null;
    // В-03: у будущих заявок онлайн — срок ответа мастера от момента сида; прошлые остаются как есть (история)
    const confirmDeadline =
      status === 'awaiting_confirmation' && online && start.getTime() > seedNow
        ? new Date(Math.max(seedNow, Math.min(seedNow + 2 * 3600000, start.getTime() - 3600000)))
        : null;
    const lines = (b.services ?? []) as Rec[];
    rows.push({
      id: String(b.id),
      businessId: String(b.businessId),
      locationId: String(b.locationId),
      staffId: String(b.staffId),
      clientId: S(b.clientId) ?? null,
      appUserId: S(b.appUserId) ?? null,
      startAt: start,
      endAt: addMinutes(start, dur),
      durationMin: dur,
      status,
      services: lines as Prisma.InputJsonValue,
      total: BigInt(Math.round(Number(b.total ?? 0))),
      resourceIds: (b.resourceIds ?? []) as Prisma.InputJsonValue,
      workplace: String(b.workplace ?? 'salon'),
      source: String(b.source ?? 'journal'),
      createdByRef: String(b.createdBy ?? 'client'),
      forWhom: String(b.forWhom ?? 'self'),
      visitorName: S(b.visitorName) ?? null,
      comment: S(b.comment) ?? null,
      prepayment: J(prepayment),
      holdUntil: holdUntil ?? confirmDeadline,
      confirmDeadline,
      cancelledLate: Boolean(b.cancelledLate),
      cancelReason: S(b.cancelReason) ?? null,
      cancelledBy: status === 'cancelled_by_client' ? 'client' : status === 'cancelled_by_master' ? 'staff' : null,
      groupEventId: S(b.groupEventId) ?? null,
      seriesId: S(b.seriesId) ?? null,
      visitId: S(b.visitId) ?? null,
      staffAssignment: S(b.staffAssignment) ?? null,
      extras: {},
      deletedAt: S(b.deletedAt) ? atLocal(String(b.deletedAt).slice(0, 16)) : null,
      createdAt: local(S(b.createdAt)),
      createdBy: 'seed',
      updatedBy: 'seed',
    });
  }
  for (let i = 0; i < rows.length; i += 1000) await prisma.booking.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
  const participants = rows.filter((r) => r.groupEventId).map((r) => r.id);

  // Занятость записей — проекция таблицы bookings (01 §7.2): пересобирается из неё целиком. Снимок мока зависит от
  // даты сида, поэтому блоки этапа 6 на рабочей базе могли разойтись с записями по времени; здесь они выводятся из
  // самих записей (и тех, что созданы через API), а не из мока. Участники групповых событий время не держат.
  {
    const all = await prisma.booking.findMany({
      where: { deletedAt: null, groupEventId: null, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
      select: { id: true, businessId: true, locationId: true, staffId: true, startAt: true, endAt: true, durationMin: true, workplace: true, services: true, resourceIds: true, status: true, holdUntil: true },
    });
    const staffRows = await prisma.staff.findMany({ select: { id: true, userId: true } });
    const personOfStaff = new Map(staffRows.map((st) => [st.id, st.userId ?? st.id]));
    const svcBuffer = new Map((await prisma.service.findMany({ select: { id: true, bufferAfterMin: true } })).map((x) => [x.id, x.bufferAfterMin ?? 0]));
    const resRows = await prisma.resource.findMany({ select: { id: true, instances: true } });
    const resOf = (rid: string) => {
      const direct = resRows.find((r) => r.id === rid);
      if (direct) return { resourceId: direct.id, instanceId: null as string | null };
      const owner = resRows.find((r) => ((r.instances ?? []) as { id: string }[]).some((i) => i.id === rid));
      return owner ? { resourceId: owner.id, instanceId: rid } : null;
    };
    await prisma.busyBlock.deleteMany({ where: { source: 'booking' } });
    await prisma.resourceBusy.deleteMany({ where: { source: 'booking' } });
    const blocks: Prisma.BusyBlockCreateManyInput[] = [];
    const resBusy: Prisma.ResourceBusyCreateManyInput[] = [];
    let k = 0;
    for (const b of all) {
      const lines = (b.services ?? []) as { staffId?: string; serviceId: string }[];
      const buffer = Math.max(0, ...lines.map((l) => svcBuffer.get(l.serviceId) ?? 0));
      const end = addMinutes(b.startAt, b.durationMin + buffer);
      const label = b.workplace === 'home' ? 'home' : b.workplace === 'visit' ? 'visit' : 'salon';
      for (const staffId of [...new Set([b.staffId, ...lines.map((l) => l.staffId).filter((x): x is string => Boolean(x))])]) {
        const personKey = personOfStaff.get(staffId);
        if (!personKey) continue;
        blocks.push({
          id: `bb_bk${String(++k).padStart(7, '0')}`,
          personKey,
          staffId,
          businessId: b.businessId,
          locationId: b.locationId,
          workplace: b.workplace,
          startAt: b.startAt,
          endAt: end,
          serviceEndAt: b.endAt,
          source: 'booking',
          sourceId: b.id,
          visibilityLabel: label,
          noShow: b.status === 'no_show',
          holdUntil: b.holdUntil,
        });
      }
      for (const rid of (b.resourceIds ?? []) as string[]) {
        const r = resOf(rid);
        if (!r) continue;
        resBusy.push({ id: `rbz_bk${String(resBusy.length + 1).padStart(7, '0')}`, resourceId: r.resourceId, instanceId: r.instanceId, businessId: b.businessId, startAt: b.startAt, endAt: end, source: 'booking', sourceId: b.id, noShow: b.status === 'no_show', holdUntil: b.holdUntil });
      }
    }
    for (let i = 0; i < blocks.length; i += 1000) await prisma.busyBlock.createMany({ data: blocks.slice(i, i + 1000) });
    for (let i = 0; i < resBusy.length; i += 1000) await prisma.resourceBusy.createMany({ data: resBusy.slice(i, i + 1000) });
    await prisma.personLock.createMany({ skipDuplicates: true, data: [...new Set(blocks.map((b) => b.personKey))].map((personKey) => ({ personKey })) });
    console.log(`seed: занятость записей пересобрана из bookings — блоков ${blocks.length}, ресурсов ${resBusy.length}`);
  }

  await prisma.groupEvent.createMany({
    skipDuplicates: true,
    data: eventsRaw
      .filter((e) => staffIds.has(String(e.staffId)))
      .map((e) => ({
        id: String(e.id),
        businessId: String(e.businessId),
        locationId: String(e.locationId),
        serviceId: String(e.serviceId),
        staffId: String(e.staffId),
        startAt: atLocal(String(e.start)),
        durationMin: Number(e.durationMin ?? 60),
        capacity: Number(e.capacity ?? 1),
        resourceIds: (e.resourceIds ?? []) as Prisma.InputJsonValue,
        onlineUrl: S(e.onlineUrl) ?? null,
        seriesId: S(e.seriesId) ?? null,
        status: String(e.status ?? 'scheduled'),
        createdAt: local(S(e.createdAt)),
        createdBy: 'seed',
      })),
  });

  // Настройки журнала бизнеса (business_settings area='journal'): пять демо-полей записи (F-01-053) — как в срезе
  // journal мока; автосписание — первая активная услуга бизнеса (тот же демо-приём, что и в моке)
  const demoFields = [
    { id: 'cf_seed_contract', key: 'contractNo', label: 'Номер договора', type: 'text', alwaysShow: false, requiredOnCreate: false, requiredOnArrived: false, editableByUser: true },
    { id: 'cf_seed_external', key: 'externalId', label: 'ID во внешней CRM', type: 'number', alwaysShow: false, requiredOnCreate: false, requiredOnArrived: false, editableByUser: true },
    { id: 'cf_seed_channel', key: 'channel', label: 'Откуда узнали', type: 'select', options: ['Инстаграм', 'Рекомендация', 'Прошёл мимо', 'Сайт'], alwaysShow: true, requiredOnCreate: false, requiredOnArrived: false, editableByUser: true },
    { id: 'cf_seed_consent', key: 'consentDate', label: 'Дата согласия на обработку данных', type: 'date', alwaysShow: false, requiredOnCreate: false, requiredOnArrived: true, editableByUser: true },
    { id: 'cf_seed_checkup', key: 'nextCheckupAt', label: 'Следующий осмотр', type: 'datetime', alwaysShow: false, requiredOnCreate: false, requiredOnArrived: false, editableByUser: false },
  ];
  const servicesAll = (core.services ?? []) as Rec[];
  const clientsAll = (core.clients ?? []) as Rec[];
  const locationsAll = (core.locations ?? []) as Rec[];
  const today = utcToLocalDate(now);
  const plus2 = utcToLocalDate(new Date(now.getTime() + 2 * 86400000));
  let waitlist = 0;
  for (const b of core.businesses) {
    const firstService = servicesAll.find((s) => s.businessId === b.id && s.active !== false);
    const data = {
      settings: {},
      visitIntervalMin: 15,
      customFieldDefs: demoFields,
      autoWriteoffServiceIds: firstService ? [String(firstService.id)] : [],
    };
    await prisma.businessSetting.upsert({
      where: { businessId_area: { businessId: b.id, area: 'journal' } },
      create: { businessId: b.id, area: 'journal', data },
      update: {},
    });
    const location = locationsAll.find((l) => l.businessId === b.id);
    const client = clientsAll.find((c) => c.businessId === b.id);
    if (!location || !client || !firstService) continue;
    const wid = `wl_seed_${b.id}`;
    const res = await prisma.waitlistEntry.createMany({
      skipDuplicates: true,
      data: [
        {
          id: wid.slice(0, 32),
          businessId: b.id,
          locationId: String(location.id),
          clientName: String(client.name),
          clientPhone: String(client.phone),
          clientId: String(client.id),
          serviceIds: [String(firstService.id)],
          staffIds: [],
          slots: [{ date: plus2, anyTime: true, intervals: [] }],
          comment: '',
          createdBy: 'seed',
        },
      ],
    });
    waitlist += res.count;
  }
  void today;
  console.log(`seed: журнал — записей ${rows.length} (участников групповых ${participants.length}), групповых событий ${eventsRaw.length}, лист ожидания ${waitlist}`);
}

// ─────────── этап 11: лояльность — по одному образцу на бизнес, чтобы экраны не были пустыми ───────────
// Мока для этого раздела нет (domain/loyalty.ts не резервирует id — см. docs/backend/07-mock-only.md), поэтому
// строки не «из мока», а придуманы: тип карты + карта, тип сертификата + сертификат, тип абонемента + абонемент,
// тип счёта + счёт — каждому бизнесу, у которого уже есть хоть один клиент (CRM, этап 5).
{
  const clientsAll2 = (core.clients ?? []) as Rec[];
  let cardTypes = 0;
  let certs = 0;
  let memberships = 0;
  let accounts = 0;
  let seq = 0;
  for (const b of core.businesses) {
    const client = clientsAll2.find((c) => c.businessId === b.id);
    if (!client) continue;
    const clientId = String(client.id);
    const ownerId = String((b as Rec).networkId ?? b.id);
    const shortId = String(b.id).slice(0, 12);
    const n = String(++seq).padStart(8, '0');

    const cardTypeId = `lct_${shortId}`.slice(0, 32);
    await prisma.loyaltyCardType.upsert({
      where: { id: cardTypeId },
      create: { id: cardTypeId, ownerId, businessId: b.id, name: 'Бонусная карта', paymentLimitPercent: 30, createdBy: 'seed', updatedBy: 'seed' },
      update: {},
    });
    const cardId = `lc_${shortId}`.slice(0, 32);
    await prisma.loyaltyCard.upsert({
      where: { id: cardId },
      create: { id: cardId, cardTypeId, businessId: b.id, clientId, number: `9${n}`, balance: 1_500n, createdBy: 'seed' },
      update: {},
    });
    cardTypes++;

    const certTypeId = `lctt_${shortId}`.slice(0, 32);
    await prisma.certificateType.upsert({
      where: { id: certTypeId },
      create: { id: certTypeId, ownerId, businessId: b.id, name: 'Подарочный сертификат 10 000 ֏', faceValue: 10_000n, validDays: 180, createdBy: 'seed', updatedBy: 'seed' },
      update: {},
    });
    const certId = `lcert_${shortId}`.slice(0, 32);
    await prisma.certificate.upsert({
      where: { id: certId },
      create: { id: certId, typeId: certTypeId, businessId: b.id, clientId, code: `SC${n}`, total: 10_000n, balance: 10_000n, status: 'active', soldAt: now, expiresAt: new Date(now.getTime() + 180 * 86_400_000), createdBy: 'seed' },
      update: {},
    });
    certs++;

    const membershipTypeId = `lmt_${shortId}`.slice(0, 32);
    await prisma.membershipType.upsert({
      where: { id: membershipTypeId },
      create: { id: membershipTypeId, ownerId, businessId: b.id, name: 'Абонемент на 10 визитов', totalVisits: 10, price: 45_000n, validDays: 365, serviceIds: [], createdBy: 'seed', updatedBy: 'seed' },
      update: {},
    });
    const membershipId = `lm_${shortId}`.slice(0, 32);
    await prisma.membershipSale.upsert({
      where: { id: membershipId },
      create: { id: membershipId, typeId: membershipTypeId, businessId: b.id, clientId, code: `SM${n}`, totalVisits: 10, remainingVisits: 7, status: 'active', soldAt: now, expiresAt: new Date(now.getTime() + 365 * 86_400_000), createdBy: 'seed' },
      update: {},
    });
    memberships++;

    const accountTypeId = `lat_${shortId}`.slice(0, 32);
    await prisma.clientAccountType.upsert({
      where: { id: accountTypeId },
      create: { id: accountTypeId, ownerId, businessId: b.id, name: 'Личный счёт', createdBy: 'seed', updatedBy: 'seed' },
      update: {},
    });
    const accountId = `la_${shortId}`.slice(0, 32);
    await prisma.clientAccount.upsert({
      where: { id: accountId },
      create: { id: accountId, typeId: accountTypeId, businessId: b.id, clientId, balance: 5_000n, createdBy: 'seed' },
      update: {},
    });
    accounts++;
  }
  console.log(`seed: лояльность — типов карт ${cardTypes}, сертификатов ${certs}, абонементов ${memberships}, счетов ${accounts}`);
}

// ─────────── этап 12: финансы и касса — 15 системных статей, кассы «Наличные»/«Карта» на филиал, методы
// оплаты cash/card, и одна реальная оплата визита на бизнес (чтобы касса дня/отчёты не были пустыми). Идемпотентно
// через проверку «уже есть» — как ensureDefaults самого раздела (FinanceCatalogService), не через upsert-по-id,
// потому что у cash_registers/payment_methods естественный ключ — (businessId/locationId), а не выдуманный id. ───
{
  let itemsCreated = 0;
  let registersCreated = 0;
  let methodsCreated = 0;
  let paymentsCreated = 0;
  for (const b of core.businesses) {
    const bizLocations = locations.filter((l) => String(l.businessId) === b.id);
    const hasItems = (await prisma.paymentItem.count({ where: { businessId: b.id } })) > 0;
    if (!hasItems) {
      await prisma.paymentItem.createMany({
        data: Object.entries(SYSTEM_ITEMS).map(([systemKey, v]) => ({ id: `fitem_${b.id}_${systemKey}`.slice(0, 32), businessId: b.id, name: v.name, kind: v.kind, systemKey, createdBy: 'seed', updatedBy: 'seed' })),
      });
      itemsCreated += Object.keys(SYSTEM_ITEMS).length;
    }
    let order = 0;
    for (const loc of bizLocations) {
      const hasRegister = (await prisma.cashRegister.count({ where: { locationId: String(loc.id) } })) > 0;
      if (hasRegister) continue;
      const cashId = `fr_${String(loc.id)}_cash`.slice(0, 32);
      const cardId = `fr_${String(loc.id)}_card`.slice(0, 32);
      await prisma.cashRegister.createMany({
        data: [
          { id: cashId, businessId: b.id, locationId: String(loc.id), name: 'Основная касса', kind: 'cash', order: order++, systemGenerated: true, createdBy: 'seed', updatedBy: 'seed' },
          { id: cardId, businessId: b.id, locationId: String(loc.id), name: 'Расчётный счёт', kind: 'card', order: order++, systemGenerated: true, createdBy: 'seed', updatedBy: 'seed' },
        ],
      });
      registersCreated += 2;
    }
    const hasMethods = (await prisma.paymentMethod.count({ where: { businessId: b.id } })) > 0;
    if (!hasMethods) {
      const firstCash = await prisma.cashRegister.findFirst({ where: { businessId: b.id, kind: 'cash' }, orderBy: { order: 'asc' } });
      const firstCard = await prisma.cashRegister.findFirst({ where: { businessId: b.id, kind: 'card' }, orderBy: { order: 'asc' } });
      await prisma.paymentMethod.createMany({
        data: [
          { id: `fpm_${b.id}_cash`.slice(0, 32), businessId: b.id, key: 'cash', label: 'Наличные', kind: 'cash', accountId: firstCash?.id ?? null, order: 0, createdBy: 'seed', updatedBy: 'seed' },
          { id: `fpm_${b.id}_card`.slice(0, 32), businessId: b.id, key: 'card', label: 'Банковская карта', kind: 'card', accountId: firstCard?.id ?? null, order: 1, createdBy: 'seed', updatedBy: 'seed' },
        ],
      });
      methodsCreated += 2;
    }
    // Одна реальная оплата — первый «пришедший» визит этого бизнеса с суммой и без оплаты ещё
    const candidate = (core.bookings ?? []).find((bk) => String(bk.businessId) === b.id && String(bk.status) === 'arrived' && Number(bk.total ?? 0) > 0);
    if (candidate) {
      const bookingRow = await prisma.booking.findUnique({ where: { id: String(candidate.id) } });
      if (bookingRow && bookingRow.paidAmount === 0n) {
        const already = (await prisma.bookingPayment.count({ where: { bookingId: bookingRow.id } })) > 0;
        if (!already) {
          const cash = await prisma.cashRegister.findFirst({ where: { businessId: b.id, kind: 'cash' } });
          const item = await prisma.paymentItem.findFirst({ where: { businessId: b.id, systemKey: 'servicePayment' } });
          if (cash && item) {
            const opId = `fop_${bookingRow.id}`.slice(0, 32);
            const payId = `pay_${bookingRow.id}`.slice(0, 32);
            const at = now;
            await prisma.finOp.create({
              data: { id: opId, businessId: b.id, locationId: bookingRow.locationId, accountId: cash.id, itemId: item.id, kind: 'income', amount: bookingRow.total, date: at, method: 'cash', partyType: bookingRow.clientId ? 'client' : 'none', partyId: bookingRow.clientId, source: 'booking', refId: bookingRow.id, docNumber: String(700_000_000 + Math.floor(Math.random() * 99_999_999)), lineLabel: 'Оплата визита', history: [{ at: at.toISOString(), by: 'seed', action: 'created' }] as Prisma.InputJsonValue, createdBy: 'seed', updatedBy: 'seed' },
            });
            await prisma.bookingPayment.create({ data: { id: payId, businessId: b.id, bookingId: bookingRow.id, serviceIndex: 0, kind: 'money', methodKey: 'cash', methodLabel: 'Наличные', accountId: cash.id, amount: bookingRow.total, finOpId: opId, createdBy: 'seed' } });
            const extras = (bookingRow.extras && typeof bookingRow.extras === 'object' ? bookingRow.extras : {}) as Record<string, unknown>;
            const payments = [...((extras.payments as unknown[]) ?? []), { id: payId, method: 'cash', amount: Number(bookingRow.total), label: 'Наличные', at: utcToLocalDate(at) }];
            await prisma.booking.update({ where: { id: bookingRow.id }, data: { extras: { ...extras, payments, paidAmount: Number(bookingRow.total) } as Prisma.InputJsonValue, paidAmount: bookingRow.total } });
            paymentsCreated++;
          }
        }
      }
    }
  }
  console.log(`seed: финансы — статей ${itemsCreated}, касс ${registersCreated}, методов оплаты ${methodsCreated}, оплат визита ${paymentsCreated}`);
}

// ─────────── этап 13: склад — 2 склада на филиал (как ensureDefaultWarehouses самого раздела), категория
// «Основные товары» + представительный набор из 3 товаров по сфере бизнеса, с приходом начального остатка,
// чтобы «Каталог» и «Остатки» не были пустыми экранами. Бизнесы-черновики (F-00-133) остаются без склада —
// как EMPTY_BUSINESS_IDS мока (src/mock/slices/stock.ts). Идемпотентно: детерминированные id + «уже есть?». ───
{
  const STOCK_CATALOG_BY_SPHERE: Record<string, { name: string; unit: string; sale: number; cost: number }[]> = {
    nails: [
      { name: 'Гель-лак «Розовый нюд»', unit: 'bottle', sale: 3000, cost: 1500 },
      { name: 'Топовое покрытие', unit: 'bottle', sale: 3500, cost: 1700 },
      { name: 'Пилка одноразовая 180/240', unit: 'pcs', sale: 300, cost: 120 },
    ],
    barber: [
      { name: 'Воск для укладки', unit: 'jar', sale: 4500, cost: 2200 },
      { name: 'Одноразовые бритвы', unit: 'pack', sale: 1500, cost: 700 },
      { name: 'Полотенце одноразовое', unit: 'pack', sale: 2500, cost: 1200 },
    ],
    dental: [
      { name: 'Анестетик (карпула)', unit: 'ampoule', sale: 0, cost: 900 },
      { name: 'Пломбировочный материал', unit: 'g', sale: 0, cost: 1400 },
      { name: 'Перчатки нитриловые', unit: 'pack', sale: 0, cost: 3500 },
    ],
    fitness: [
      { name: 'Изотонический напиток', unit: 'bottle', sale: 1500, cost: 700 },
      { name: 'Протеиновый батончик', unit: 'pcs', sale: 1200, cost: 600 },
      { name: 'Полотенце спортивное', unit: 'pcs', sale: 2000, cost: 900 },
    ],
  };
  const DEFAULT_CATALOG = STOCK_CATALOG_BY_SPHERE.barber!;
  const EMPTY_BUSINESS_IDS = new Set(['biz_empty', 'biz_empty_solo']);
  let warehousesCreated = 0;
  let categoriesCreated = 0;
  let productsCreated = 0;
  let incomeOpsCreated = 0;
  for (const b of businesses) {
    const bId = String(b.id);
    if (EMPTY_BUSINESS_IDS.has(bId)) continue;
    const sphere = Array.isArray(b.sphereIds) && b.sphereIds.length ? String(b.sphereIds[0]) : '';
    const catalog = STOCK_CATALOG_BY_SPHERE[sphere] ?? DEFAULT_CATALOG;
    const bizLocations = locations.filter((l) => String(l.businessId) === bId);
    for (const loc of bizLocations) {
      const locId = String(loc.id);
      const hasWarehouse = (await prisma.warehouse.count({ where: { locationId: locId } })) > 0;
      const whWriteoffId = `wh_${locId}_wo`.slice(0, 32);
      const whSaleId = `wh_${locId}_sale`.slice(0, 32);
      if (!hasWarehouse) {
        await prisma.warehouse.createMany({
          data: [
            { id: whWriteoffId, businessId: bId, locationId: locId, name: 'Расходники', type: 'writeoff', comment: 'Для учёта расходных материалов', order: 0, createdBy: 'seed', updatedBy: 'seed' },
            { id: whSaleId, businessId: bId, locationId: locId, name: 'Товары', type: 'sale', comment: 'Для учёта продаж в магазине', order: 1, createdBy: 'seed', updatedBy: 'seed' },
          ],
        });
        warehousesCreated += 2;
      }
      const hasCategory = (await prisma.stockCategory.count({ where: { locationId: locId } })) > 0;
      const catId = `gcat_${locId}_root`.slice(0, 32);
      if (!hasCategory) {
        await prisma.stockCategory.create({ data: { id: catId, businessId: bId, locationId: locId, name: 'Основные товары', createdBy: 'seed', updatedBy: 'seed' } });
        categoriesCreated++;
      }
      const hasGoods = (await prisma.product.count({ where: { locationId: locId } })) > 0;
      if (hasGoods) continue;
      const goodIds: string[] = [];
      for (let i = 0; i < catalog.length; i++) {
        const item = catalog[i]!;
        const id = `gd_${locId}_${i}`.slice(0, 32);
        await prisma.product.create({
          data: {
            id,
            businessId: bId,
            locationId: locId,
            categoryId: catId,
            name: item.name,
            saleUnit: item.unit,
            writeoffUnit: item.unit,
            unitRatio: 1,
            salePrice: BigInt(item.sale),
            costPrice: BigInt(item.cost),
            criticalStock: 5,
            desiredStock: 30,
            createdBy: 'seed',
            updatedBy: 'seed',
          },
        });
        goodIds.push(id);
        productsCreated++;
      }
      // Приход начального остатка — один документ на филиал, без движения кассы (paid: false), как
      // «получено на баланс при переходе с бумаги», а не настоящая закупка сегодня.
      const opId = `sop_${locId}_seed`.slice(0, 32);
      await prisma.stockOp.create({
        data: { id: opId, businessId: bId, locationId: locId, number: '100000', type: 'income', date: localDate('2026-08-01T10:00'), warehouseId: whSaleId, counterpartyName: 'Начальный остаток', paid: false, comment: 'Сид: начальный остаток при открытии склада', createdBy: 'seed', updatedBy: 'seed' },
      });
      await prisma.stockOpLine.createMany({
        data: goodIds.map((goodId, i) => ({ id: `sol_${locId}_${i}`.slice(0, 32), opId, businessId: bId, goodId, qtySale: 25, unitPrice: BigInt(catalog[i]!.cost), costTotal: BigInt(catalog[i]!.cost * 25) })),
      });
      incomeOpsCreated++;
    }
  }
  console.log(`seed: склад — складов ${warehousesCreated}, категорий ${categoriesCreated}, товаров ${productsCreated}, приходов начального остатка ${incomeOpsCreated}`);
}

// ─────────── этап 14: зарплата — «Основные настройки» на филиал, упрощённая схема 35% с услуг каждому
// мастеру без схемы (как bulkApplyDefaultScheme самого раздела) и два шаблона премии/штрафа на бизнес —
// чтобы «Расчёт» и «Премии и штрафы» не были пустыми экранами. Идемпотентно: детерминированные id + «уже есть?». ───
{
  let settingsCreated = 0;
  let schemesCreated = 0;
  let bonusTypesCreated = 0;
  for (const loc of locations) {
    const locId = String(loc.id);
    const bizId = String(loc.businessId);
    const hasSettings = (await prisma.payrollSettings.count({ where: { locationId: locId } })) > 0;
    if (!hasSettings) {
      await prisma.payrollSettings.create({ data: { locationId: locId, businessId: bizId } });
      settingsCreated++;
    }
  }
  for (const b of businesses) {
    const bId = String(b.id);
    const masters = staffRecs.filter((s) => S(s.businessId) === bId && S(s.role) === 'master');
    for (const s of masters) {
      const staffId = String(s.id);
      const hasScheme = (await prisma.payrollScheme.count({ where: { staffId } })) > 0;
      if (hasScheme) continue;
      const scheme: Rec = {
        personalServices: {
          enabled: true,
          defaultPayout: { unit: 'percent', value: 35 },
          overrides: [],
          demoConsumablesPercent: 0,
          consumables: { mode: 'off', applyClientDiscount: false },
          loyaltyAdjustment: { enabled: false, includeDiscount: false, includeBonus: false, includeMembership: false, includeClientAccount: false, includeCertificate: false, includePromotion: false, promoPayout: { unit: 'percent', value: 0 }, promoOverrides: [] },
          groupEvents: { enabled: false, minPayoutOn: false, minPayout: { unit: 'percent', value: 0 }, atLeastOneOn: false, atLeastOnePayout: { unit: 'percent', value: 0 }, perAttendeeMode: 'none', threshold: 0 },
        },
        productSales: { enabled: false, defaultPayout: { unit: 'percent', value: 0 }, overrides: [], demoCostPercent: 0, costBasis: { enabled: false, order: 'discountFirst' }, loyaltyAdjustment: { enabled: false, includeDiscount: false, includeBonus: false, includeMembership: false, includeClientAccount: false, includeCertificate: false, includePromotion: false, promoPayout: { unit: 'percent', value: 0 }, promoOverrides: [] } },
        workday: { enabled: false, baseAmount: 0, basePeriod: 'day', guaranteedMinimum: { enabled: false, amount: 0, period: 'month' } },
        records: { enabled: false, perServicePayout: { unit: 'percent', value: 0 }, perServiceOverrides: [], onlineWidgetEnabled: false, onlineWidgetPayout: { unit: 'percent', value: 0 } },
        extraServiceRevenue: { enabled: false, percent: 0, base: 'turnover' },
        extraProductRevenue: { enabled: false, percent: 0, base: 'turnover' },
      };
      await prisma.payrollScheme.create({ data: { staffId, businessId: bId, data: scheme as unknown as Prisma.InputJsonValue, createdBy: 'seed', updatedBy: 'seed' } });
      schemesCreated++;
    }
    const hasBonusTypes = (await prisma.bonusPenaltyType.count({ where: { businessId: bId } })) > 0;
    if (!hasBonusTypes) {
      await prisma.bonusPenaltyType.createMany({
        data: [
          { id: `bpt_${bId}_bonus`.slice(0, 32), businessId: bId, kind: 'bonus', name: 'Премия за перевыполнение плана', defaultAmount: 20000n },
          { id: `bpt_${bId}_penalty`.slice(0, 32), businessId: bId, kind: 'penalty', name: 'Штраф за опоздание', defaultAmount: 5000n },
        ],
      });
      bonusTypesCreated += 2;
    }
  }
  console.log(`seed: зарплата — настроек локации ${settingsCreated}, схем мастеров ${schemesCreated}, типов премий/штрафов ${bonusTypesCreated}`);
}

console.log(
  `seed: людей ${users.length} (клиентов ${core.appUsers.length}), логинов администраторов ${admins.length}, команда платформы 1; ` +
    `сетей ${networks.length}, бизнесов ${businesses.length}, филиалов ${locations.length}, сотрудников ${core.staff.length}, ` +
    `должностей ${positions.length}, приглашений ${invited.length}; ` +
    `каталог — категорий ${categoriesRaw.length}, услуг ${servicesRaw.length}, ресурсов ${resourcesRaw.length}; ` +
    `CRM — клиентов ${clientsRaw.length} — ${Date.now() - t0} мс`,
);
await prisma.$disconnect();
