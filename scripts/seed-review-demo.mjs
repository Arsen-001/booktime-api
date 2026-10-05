// Демо-салон «BookTime Demo» для проверяющих App Store / Google Play — только через публичный HTTP API сервера.
// Описание данных: booking-platform/docs/store/review-notes.md («Данные на production»).
//
//   node scripts/seed-review-demo.mjs --api https://api-staging.booktime.am --code-env STAGING_REVIEW_LOGIN_CODE
//   node scripts/seed-review-demo.mjs --api https://api.booktime.am --code-env PRODUCTION_REVIEW_LOGIN_CODE --production
//
// Код входа проверяющих берётся из переменной окружения с именем --code-env, а если её нет — из файла
// ~/.booktime-secrets/review-login.env (строки KEY=VALUE; путь меняет --secrets). Код, cookie и токены не печатаются.
//
// Что делает (повторный запуск ничего не дублирует):
//   1. Вход владельца +37400000102 (кабинет) и клиента +37400000101 «App Review» (клиентское приложение).
//   2. Бизнес «BookTime Demo» (салон, сфера nails, slug booktime-demo) — регистрирует, если у владельца его нет.
//   3. Описание «это демо», 1 категория и 5 услуг, 2 мастера (владелец + «Лилит»), график Пн–Сб 10–19 на 8 недель.
//   4. Мастера «По ссылке» (calendarVisibility=link): нет в каталоге/поиске и sitemap, но /b/booktime-demo открывается.
//   5. 25 вымышленных клиентов (+374 00 1XX XXX), записи на ближайшую неделю — только если неделя почти пустая.
//   6. Одна предстоящая запись «App Review» в BookTime Demo, если у него нет ни одной.
// Прямого доступа к базе нет и быть не должно: только HTTP, как сайт и приложения.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─────────── параметры ───────────

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || !arg('api')) {
  console.log('node scripts/seed-review-demo.mjs --api <https://api…> --code-env <ИМЯ_ПЕРЕМЕННОЙ> [--secrets <файл>] [--promo <код>] [--production]');
  process.exit(flag('help') ? 0 : 1);
}

const API = arg('api').replace(/\/+$/, '');
const CODE_ENV = arg('code-env', 'REVIEW_LOGIN_CODE');
const SECRETS = arg('secrets', path.join(os.homedir(), '.booktime-secrets', 'review-login.env'));
const PROMO = arg('promo'); // необязательный промокод «бесплатный месяц» при регистрации бизнеса
const TZ = 'Asia/Yerevan';

// Production — только с явным --production (защита от случайного запуска не на том окружении)
const host = new URL(API).host;
if (host === 'api.booktime.am' && !flag('production')) {
  console.error('Это production (api.booktime.am). Запуск только с флагом --production.');
  process.exit(1);
}

function readCode() {
  let code = process.env[CODE_ENV];
  if (!code && fs.existsSync(SECRETS)) {
    for (const line of fs.readFileSync(SECRETS, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\s#]*)["']?/);
      if (m && m[1] === CODE_ENV) code = m[2];
    }
  }
  if (!code || !/^\d{4}$/.test(code)) {
    console.error(`Нет кода входа проверяющих: переменная ${CODE_ENV} (или строка в ${SECRETS}) — 4 цифры.`);
    process.exit(1);
  }
  return code;
}
const CODE = readCode();

// ─────────── данные демо ───────────

const OWNER_PHONE = '+37400000102';
const CLIENT_PHONE = '+37400000101';
const BUSINESS_NAME = 'BookTime Demo';
const SLUG = 'booktime-demo';
const SPHERE = 'nails';
const OWNER_NAME = 'Ани';
const MASTER = { name: 'Лилит', phone: '+37400100200', position: 'Мастер маникюра' };
const HOURS = [{ from: '10:00', to: '19:00' }];
const SCHEDULE_DAYS = 56; // 8 недель вперёд; повторный запуск продлевает график
const WEEK_TARGET = 14; // столько активных записей на ближайшие 7 дней считаем «журнал не пустой»

const DESCRIPTION = {
  ru: 'Демо-салон BookTime для проверки приложения. Мастера, клиенты и записи здесь вымышленные.',
  hy: 'BookTime-ի ցուցադրական սրահ՝ հավելվածը ստուգելու համար։ Վարպետները, հաճախորդները և գրանցումները հորինված են։',
  en: 'BookTime demo salon for app review. Masters, clients and bookings here are fictional.',
};
const CATEGORY = { ru: 'Маникюр и педикюр', hy: 'Մատնահարդարում և ոտնահարդարում', en: 'Manicure & pedicure' };
const SERVICES = [
  { name: { ru: 'Классический маникюр', hy: 'Դասական մատնահարդարում', en: 'Classic manicure' }, durationMin: 60, priceMin: 5000 },
  { name: { ru: 'Маникюр с покрытием гель-лак', hy: 'Մատնահարդարում գել-լաքով', en: 'Gel polish manicure' }, durationMin: 90, priceMin: 9000 },
  { name: { ru: 'Педикюр', hy: 'Ոտնահարդարում', en: 'Pedicure' }, durationMin: 75, priceMin: 9000 },
  { name: { ru: 'Наращивание ногтей', hy: 'Եղունգների երկարացում', en: 'Nail extensions' }, durationMin: 120, priceMin: 15000 },
  { name: { ru: 'Снятие покрытия', hy: 'Ծածկույթի հեռացում', en: 'Polish removal' }, durationMin: 30, priceMin: 2000 },
];
// Только имена, номера — в зоне +374 00 1XX XXX (её не выдают абонентам)
const CLIENT_NAMES = [
  'Мариам', 'Нарине', 'Гаяне', 'Арпи', 'Седа', 'Лусине', 'Татевик', 'Мане', 'Сона', 'Ануш', 'Эмма', 'Нуне', 'Карине',
  'Астхик', 'Шушан', 'Мери', 'Ева', 'Элен', 'Арев', 'Гоар', 'Сюзанна', 'Анаит', 'Рузанна', 'Офелия', 'Армине',
];
const CLIENTS = CLIENT_NAMES.map((name, i) => ({ name, phone: `+374001${String(101 + i).padStart(5, '0')}`, gender: 'female' }));

// ─────────── HTTP ───────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Сессия = своя «банка» cookie. Значения cookie никуда не выводятся. */
function session(label) {
  const jar = new Map();
  async function call(method, url, body, headers = {}) {
    const res = await fetch(API + url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        'User-Agent': 'booktime-seed-review-demo',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`${label}: ${method} ${url} → ${res.status} ${data?.code ?? ''} ${data?.message ?? ''}`.trim());
      err.status = res.status;
      err.code = data?.code;
      err.retryAfter = Number(data?.retryAfter ?? res.headers.get('retry-after') ?? 0);
      throw err;
    }
    return data;
  }
  return { call, get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b ?? {}, h), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b) };
}

/** Вход по номеру проверяющего: код из env, 60 с между кодами — ждём, если сервер просит */
async function login(s, phone, app, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s.post('/v1/auth/code', { phone, channel: 'telegram', locale: 'ru' });
      break;
    } catch (e) {
      if (e.code !== 'code_resend_wait' || attempt === 2) throw e;
      const wait = Math.max(5, e.retryAfter || 60) + 1;
      console.log(`  ${phone}: повтор кода через ${wait} с`);
      await sleep(wait * 1000);
    }
  }
  return s.post('/v1/auth/verify', { phone, code: CODE, app, name, consent: true, locale: 'ru' });
}

// ─────────── даты (Ереван) ───────────

const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 — воскресенье

// ─────────── основной сценарий ───────────

const ACTIVE = new Set(['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed']);
const summary = {};

async function main() {
  console.log(`API: ${API}`);
  const owner = session('owner');
  const client = session('client');

  // 1. Вход владельца
  let me = await login(owner, OWNER_PHONE, 'business', OWNER_NAME);
  console.log(`Владелец вошёл (${OWNER_PHONE.slice(0, 7)}…), бизнесов: ${me.memberships.length}`);

  // 2. Бизнес: найти свой «BookTime Demo» или зарегистрировать
  let membership = me.memberships.find((m) => m.businessName === BUSINESS_NAME && m.role === 'owner');
  let businessId = membership?.businessId;
  if (!businessId) {
    // Slug должен быть свободен: если /b/booktime-demo уже открывается и это не наш бизнес — стоп
    try {
      const pub = await session('public').get(`/v1/public/b/${SLUG}`);
      if (pub?.business) throw Object.assign(new Error(`slug ${SLUG} уже занят чужим бизнесом (${pub.business.name}) — остановились`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      if (e.status !== 404) throw e;
    }
    const reg = await owner.post(
      '/v1/biz',
      { kind: 'salon', name: BUSINESS_NAME, sphereIds: [SPHERE], phone: OWNER_PHONE, ownerName: OWNER_NAME, district: 'kentron', address: 'Ереван', ...(PROMO ? { promoCode: PROMO } : {}) },
      { 'Idempotency-Key': `seed-review-demo-${randomUUID()}` },
    );
    businessId = reg.businessId;
    console.log(`Бизнес зарегистрирован (promoApplied: ${reg.promoApplied})`);
    me = await owner.get('/v1/auth/session').then((r) => r.session);
  } else {
    console.log('Бизнес уже есть — дополняем');
  }
  const B = `/v1/biz/${businessId}`;
  let core = await owner.get(`${B}/core`);
  const business = core.businesses.find((b) => b.id === businessId);
  summary.slug = business.slug;
  if (business.slug !== SLUG) console.warn(`ВНИМАНИЕ: slug получился «${business.slug}», а не «${SLUG}» — ссылка для проверяющих другая`);
  const locationId = business.locationIds[0];

  // 3. Описание и часы филиала
  if (business.description?.ru !== DESCRIPTION.ru) await owner.patch(B, { description: DESCRIPTION });
  const location = core.locations.find((l) => l.id === locationId);
  if (location && location.hoursText !== 'Пн–Сб 10:00–19:00') await owner.patch(`${B}/locations/${locationId}`, { hoursText: 'Пн–Сб 10:00–19:00' });

  // 4. Категория и услуги
  const categories = await owner.get(`${B}/categories`);
  let category = categories.find((c) => c.name?.ru === CATEGORY.ru);
  if (!category) category = await owner.post(`${B}/categories`, { name: CATEGORY, onlineNameEnabled: false });
  const existingServices = await owner.get(`${B}/services`);
  const serviceIds = [];
  for (const sv of SERVICES) {
    let row = existingServices.find((x) => x.name?.ru === sv.name.ru);
    if (!row) {
      row = await owner.post(`${B}/services`, {
        sphereId: SPHERE,
        categoryId: category.id,
        name: sv.name,
        kind: 'individual',
        durationMin: sv.durationMin,
        priceMin: sv.priceMin,
        techBreak: 'none',
        photos: [],
        onlineBookable: true,
      });
    }
    serviceIds.push(row.id);
  }
  summary.services = serviceIds.length;

  // 5. Мастера: владелец + второй мастер без входа в кабинет
  let staffRows = (await owner.get(`${B}/staff`)).map((r) => r.staff);
  const ownerStaff = staffRows.find((s) => s.role === 'owner');
  let master = staffRows.find((s) => s.phone === MASTER.phone && s.status !== 'fired') ?? staffRows.find((s) => s.phone === MASTER.phone);
  if (!master) {
    const added = await owner.post(
      `${B}/staff`,
      { name: MASTER.name, role: 'master', phone: MASTER.phone, position: MASTER.position, sphereIds: [SPHERE], locationIds: [locationId], grantAccess: false },
      { 'Idempotency-Key': `seed-review-demo-${randomUUID()}` },
    );
    master = added.staff;
  }
  // Сотрудник без аккаунта остаётся «приглашён» (invited), а записывают онлайн только к «active». Другого пути через
  // API нет: «уволить» и сразу «восстановить» (первые 24 ч) делает его активным без входа в кабинет.
  if (master.status === 'invited') {
    await owner.post(`${B}/staff/${master.id}/fire`, { date: todayLocal(), reason: 'demo: activate without account' });
    master = await owner.post(`${B}/staff/${master.id}/restore`);
  } else if (master.status === 'fired') {
    master = await owner.post(`${B}/staff/${master.id}/restore`);
  }
  const profile = { sphereIds: [SPHERE], workplaces: ['salon'], serviceIds, calendarVisibility: 'link', confirmMode: 'instant', onlineBookingEnabled: true, locationIds: [locationId] };
  await owner.patch(`${B}/staff/${ownerStaff.id}`, { ...profile, position: 'Мастер маникюра' });
  await owner.patch(`${B}/staff/${master.id}`, profile);
  staffRows = (await owner.get(`${B}/staff`)).map((r) => r.staff);
  const masters = [ownerStaff.id, master.id].map((id) => staffRows.find((s) => s.id === id));
  summary.staff = masters.map((s) => `${s.name} (${s.status})`);

  // 6. График: Пн–Сб 10–19 на 8 недель вперёд
  const today = todayLocal();
  const dates = [];
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const d = addDays(today, i);
    if (weekday(d) !== 0) dates.push(d);
  }
  await owner.put(`${B}/schedule/cells`, { staffIds: masters.map((s) => s.id), dates, typeId: 'work', hours: HOURS, locationId });
  summary.scheduleUntil = dates.at(-1);

  // 7. Клиенты
  const clientRows = await owner.get(`${B}/clients`);
  const byPhone = new Map(clientRows.map((c) => [c.phone, c]));
  for (const c of CLIENTS) {
    if (byPhone.has(c.phone)) continue;
    const row = await owner.post(`${B}/clients`, { name: c.name, phone: c.phone, gender: c.gender, locale: 'ru' });
    byPhone.set(c.phone, row);
  }
  const demoClients = CLIENTS.map((c) => byPhone.get(c.phone)).filter(Boolean);
  summary.clients = demoClients.length;

  // 8. Записи на ближайшую неделю — только если неделя почти пустая
  const weekTo = addDays(today, 6);
  const weekBookings = (await owner.get(`${B}/bookings?from=${today}&to=${weekTo}`)).filter((b) => ACTIVE.has(b.status));
  let created = 0;
  if (weekBookings.length < WEEK_TARGET) {
    const pub = session('public');
    let k = weekBookings.length;
    for (let day = 0; day < 7 && weekBookings.length + created < WEEK_TARGET; day++) {
      const date = addDays(today, day);
      if (weekday(date) === 0) continue;
      for (const [mi, s] of masters.entries()) {
        // 1–2 записи на мастера в день, утро и вторая половина дня
        for (const part of [0, 1]) {
          if (weekBookings.length + created >= WEEK_TARGET) break;
          const sv = SERVICES[(k + mi) % SERVICES.length];
          const svcId = serviceIds[(k + mi) % SERVICES.length];
          const q = new URLSearchParams({ staffId: s.id, date, durationMin: String(sv.durationMin), serviceId: svcId, locationId });
          const slots = await pub.get(`/v1/public/b/${business.slug}/slots?${q}`);
          const pick = slots.filter((x) => (part === 0 ? x.start.slice(11) < '13:00' : x.start.slice(11) >= '14:00'));
          if (!pick.length) continue;
          const slot = pick[(k * 7) % pick.length];
          const cl = demoClients[k % demoClients.length];
          try {
            await owner.post(
              `${B}/bookings/place`,
              { source: 'journal', staffId: s.id, start: slot.start, services: [{ serviceId: svcId }], locationId, client: { clientId: cl.id }, staffAssignment: 'specific' },
              { 'Idempotency-Key': `seed-review-demo-${randomUUID()}` },
            );
            created++;
          } catch (e) {
            console.warn(`  запись ${date} ${slot.start.slice(11)} пропущена: ${e.code ?? e.message}`);
          }
          k++;
        }
      }
    }
  }
  summary.weekBookings = { before: weekBookings.length, created };

  // 9. Клиент «App Review»: вход (аккаунт), имя, одна предстоящая запись в BookTime Demo
  const cs = await login(client, CLIENT_PHONE, 'client', 'App Review');
  if (cs.user.name !== 'App Review') await client.patch('/v1/me/account', { name: 'App Review' });
  const mine = await client.get(`/v1/me/bookings?businessId=${businessId}`);
  const upcoming = mine?.upcoming ?? []; // отменённые сервер кладёт отдельно
  if (!upcoming.length) {
    const pub = session('public');
    let done = false;
    for (let day = 3; day < 10 && !done; day++) {
      const date = addDays(today, day);
      if (weekday(date) === 0) continue;
      const q = new URLSearchParams({ staffId: master.id, date, durationMin: String(SERVICES[0].durationMin), serviceId: serviceIds[0], locationId });
      const slots = (await pub.get(`/v1/public/b/${business.slug}/slots?${q}`)).filter((x) => x.start.slice(11) >= '12:00');
      if (!slots.length) continue;
      await client.post('/v1/me/bookings', { staffId: master.id, serviceId: serviceIds[0], start: slots[0].start, locationId, workplace: 'salon' });
      summary.appReviewBooking = slots[0].start;
      done = true;
    }
  } else {
    summary.appReviewBooking = `уже есть (${upcoming.length})`;
  }

  // 10. Сверка: публичная страница и окна
  const pubPage = await session('public').get(`/v1/public/b/${business.slug}`);
  summary.public = { status: 'ok', staff: pubPage.staff.length, services: pubPage.services.length };
  summary.businessStatus = (await owner.get(B)).status;
  console.log('\nГотово:', JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
