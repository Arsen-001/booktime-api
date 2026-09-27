import 'dotenv/config';
import { PrismaService } from '../src/common/prisma.service.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { loadMockCore } from './seed/mock-core.js';

/**
 * Сид разработки (npx prisma db seed; его же зовёт prisma migrate reset). Строит те же данные, что демо фронта:
 * ядро мока (booking-platform/src/mock/seed) → таблицы сервера. Каждый этап дописывает свой раздел.
 *
 * Только для разработки: пароли демо-входов известны (ниже), поэтому в production сид не запускается.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('seed: в production не запускается');
  process.exit(1);
}

/** Вход команды платформы для разработки (Р11): логин/пароль, код приходит на этот номер (заглушка — в лог) */
export const DEV_PLATFORM = { login: 'platform', password: 'booktime-dev', phone: '+37400199990', name: 'Команда BookTime' };

/** id человека для сотрудника мока: мастер/владелец/админ — это люди (users), сотрудник ссылается на них (этап 3) */
export const userIdOfStaff = (staffId: string) => `au_${staffId}`;

const prisma = new PrismaService();
const core = loadMockCore();
const t0 = Date.now();
const now = new Date();

// ─────────── этап 2: люди и вход ───────────
// Клиенты приложения (AppUser мока) — с теми же id, что во фронте, чтобы экраны клиента видели те же данные
const byPhone = new Map<string, string>();
const users: { id: string; phone: string | null; name: string; locale: string; createdAt: Date }[] = [];
const profiles: { userId: string; gender: string; birthday: string | null; district: string | null; consentAt: Date; consentVersion: string }[] = [];
const localDate = (s?: string) => (s ? new Date(`${s.length === 10 ? `${s}T12:00` : s}:00Z`) : now);

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
// Команда платформы
const platformUserId = 'au_platform';
users.push({ id: platformUserId, phone: DEV_PLATFORM.phone, name: DEV_PLATFORM.name, locale: 'ru', createdAt: now });

await prisma.user.createMany({ data: users.map((u) => ({ ...u, createdBy: 'seed', updatedBy: 'seed' })) });
await prisma.appProfile.createMany({ data: profiles });

// Логины администраторов (F-00-034): пароль разработки = логин → первый вход просит сменить (как в моке)
const admins = core.staff.filter((s) => s.role === 'admin' && s.login);
for (const s of admins) {
  const login = s.login!.toLowerCase();
  await prisma.staffLogin.create({
    data: {
      id: `sl_${s.id}`.slice(0, 32),
      login,
      passwordHash: await hashPassword(login),
      userId: (s.phone && byPhone.get(s.phone)) || userIdOfStaff(s.id),
      staffId: s.id,
      businessId: s.businessId,
      mustChangePassword: true,
      disabledAt: s.status === 'disabled' || s.status === 'fired' ? now : null,
      createdBy: 'seed',
      updatedBy: 'seed',
    },
  });
}
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

console.log(
  `seed: людей ${users.length} (клиентов ${core.appUsers.length}), логинов администраторов ${admins.length}, команда платформы 1 — ${Date.now() - t0} мс`,
);
await prisma.$disconnect();
