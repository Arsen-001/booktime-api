import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/common/prisma.service.js';
import { norm } from '../src/common/text.js';
import { localToUtc, utcToLocalDate } from '../src/common/time/time.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
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

console.log(
  `seed: людей ${users.length} (клиентов ${core.appUsers.length}), логинов администраторов ${admins.length}, команда платформы 1; ` +
    `сетей ${networks.length}, бизнесов ${businesses.length}, филиалов ${locations.length}, сотрудников ${core.staff.length}, ` +
    `должностей ${positions.length}, приглашений ${invited.length} — ${Date.now() - t0} мс`,
);
await prisma.$disconnect();
