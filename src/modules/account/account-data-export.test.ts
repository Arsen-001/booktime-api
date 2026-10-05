/** «Мои данные» (GET /v1/me/data-export): форма файла и белый список полей — секреты не попадают. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMyDataExport, dataExportFilename, DATA_EXPORT_LOGIN_EVENTS, type RawExportInput } from './account-data-export.js';

const d = (s: string) => new Date(s);

/** Строки «как из базы» — вместе с полями, которых в файле быть не должно */
function input(): RawExportInput {
  const secrets = {
    tokenHash: 'SECRET_SESSION_HASH',
    passwordHash: 'SECRET_PASSWORD_HASH',
    refreshTokenEnc: 'SECRET_APPLE_REFRESH',
    subject: 'SECRET_PROVIDER_SUBJECT',
    accessHash: 'SECRET_BOOKING_ACCESS',
    prepayment: { bankAccount: 'SECRET_SALON_BANK' },
    token: 'SECRET_PUSH_TOKEN',
  };
  return {
    user: { id: 'au_01', name: 'Ани', phone: '+37400160001', locale: 'ru', twoFactorEnabled: false, createdAt: d('2026-09-01T10:00:00Z'), deleteRequestedAt: null, dataBlockRequestedAt: null, ...secrets } as never,
    appProfile: { gender: 'female', birthday: '1995-05-01', district: 'kentron', photoUrl: null, bigFont: false, timeFormat: '24h', newsPushOptOut: false, consentAt: d('2026-09-01T10:00:00Z'), consentVersion: '2026-09', ...secrets } as never,
    identities: [{ provider: 'apple', email: null, createdAt: d('2026-10-01T10:00:00Z'), lastUsedAt: null, ...secrets } as never],
    bookings: [
      {
        id: 'bk_1', businessId: 'biz_1', staffId: 'st_1', startAt: d('2026-10-05T08:00:00Z'), endAt: d('2026-10-05T09:00:00Z'), durationMin: 60,
        status: 'confirmed', services: [{ serviceId: 'sv_1', staffId: 'st_1', qty: 1 }, { serviceId: 'sv_gone' }], total: 5000n, paidAmount: 0n,
        source: 'online', forWhom: 'self', visitorName: null, comment: 'у окна', cancelReason: null, createdAt: d('2026-10-01T10:00:00Z'), deletedAt: null,
        ...secrets,
      } as never,
    ],
    businessNames: new Map([['biz_1', 'Nuri Nail Studio']]),
    staffNames: new Map([['st_1', 'Ева']]),
    serviceNames: new Map([['sv_1', { ru: 'Маникюр', en: 'Manicure' }]]),
    favorites: [{ targetType: 'staff', targetId: 'st_1', newsMuted: false, createdAt: d('2026-09-02T10:00:00Z') }],
    starRatings: [{ staffId: 'st_1', bookingId: 'bk_0', createdAt: d('2026-09-03T10:00:00Z') }],
    staffReviews: [{ staffId: 'st_1', businessId: 'biz_1', bookingId: 'bk_0', rating: 5, text: 'Отлично', createdAt: d('2026-09-03T10:00:00Z') }],
    locationReviews: [],
    diary: [{ serviceName: 'Стрижка', masterName: 'Арам', date: '2026-08-01', amount: 3000n, createdAt: d('2026-08-01T10:00:00Z') }],
    staff: [{ id: 'st_9', businessId: 'biz_1', name: 'Ани', phone: '', email: 'ani@example.com', role: 'master', status: 'active', firedAt: null, deletedAt: null, ...secrets } as never],
    sessions: [{ app: 'client', device: 'iPhone', ip: '10.0.0.1', createdAt: d('2026-10-01T10:00:00Z'), lastSeenAt: d('2026-10-04T10:00:00Z'), ...secrets } as never],
    loginEvents: Array.from({ length: 150 }, (_, i) => ({ at: d('2026-10-01T10:00:00Z'), method: 'code', channel: 'telegram', app: 'client', result: i ? 'ok' : 'wrong_code', device: 'iPhone', ip: '10.0.0.1', id: `le_${i}` })),
    dataExports: [{ at: d('2026-10-04T10:00:00Z') }],
  };
}

test('файл «Мои данные»: верхние ключи и основные поля', () => {
  const out = buildMyDataExport(input(), d('2026-10-04T12:00:00Z'));
  assert.deepEqual(Object.keys(out), [
    'format', 'exportedAt', 'profile', 'appProfile', 'consents', 'identities', 'bookings', 'favorites', 'reviews',
    'loyaltyCards', 'certificates', 'memberships', 'waitlist', 'salonCards', 'supportTickets', 'telegram', 'searchRequests',
    'diary', 'staffProfiles', 'sessions', 'loginEvents', 'dataExports',
  ]);
  assert.equal(out.profile.phone, '+37400160001');
  assert.deepEqual(out.consents, [{ document: 'terms', version: '2026-09', acceptedAt: '2026-09-01T10:00:00.000Z' }]);
  assert.equal(out.bookings[0]!.business, 'Nuri Nail Studio');
  assert.equal(out.bookings[0]!.master, 'Ева');
  assert.deepEqual(out.bookings[0]!.services, [{ name: { ru: 'Маникюр', en: 'Manicure' }, qty: 1 }, { name: null, qty: 1 }]);
  assert.equal(out.bookings[0]!.total, 5000);
  assert.equal(out.diary[0]!.amount, 3000);
  assert.equal(out.staffProfiles[0]!.business, 'Nuri Nail Studio');
  assert.equal(out.staffProfiles[0]!.phone, null);
  assert.equal(out.loginEvents.length, DATA_EXPORT_LOGIN_EVENTS);
  assert.deepEqual(out.identities, [{ provider: 'apple', email: null, linkedAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null }]);
});

test('файл «Мои данные»: секреты и лишние поля не попадают, JSON сериализуется (BigInt → число)', () => {
  const json = JSON.stringify(buildMyDataExport(input()));
  assert.doesNotMatch(json, /SECRET_/);
  for (const key of ['tokenHash', 'passwordHash', 'refreshTokenEnc', 'subject', 'accessHash', 'prepayment', '"token"', 'codeHash']) {
    assert.ok(!json.includes(key), `нет поля ${key}`);
  }
});

/** Клиент без кабинета: карты, сертификаты, абонементы, лист ожидания, карточки в салонах, обращения */
function clientInput(): RawExportInput {
  const base = input();
  const salonSecrets = { note: 'SECRET_SALON_NOTE', tags: ['SECRET_TAG'], customFieldValues: { f1: 'SECRET_FIELD' }, nationalId: 'SECRET_ID', avatarUrl: 'data:SECRET', importanceClass: 'gold' };
  return {
    ...base,
    staff: [],
    loyaltyCards: [{ businessId: 'biz_1', cardType: 'Золотая', number: 'C-001', balance: 1200n, createdAt: d('2026-09-05T10:00:00Z'), data: { SECRET_: 1 } } as never],
    certificates: [{ businessId: 'biz_1', type: 'На 10 000', code: 'GIFT-1', total: 10000n, balance: 4000n, status: 'active', soldAt: d('2026-09-06T10:00:00Z'), expiresAt: d('2027-09-06T10:00:00Z') }],
    memberships: [{ businessId: 'biz_1', type: '10 визитов', code: 'M-1', totalVisits: 10, remainingVisits: 7, status: 'active', soldAt: d('2026-09-07T10:00:00Z'), expiresAt: d('2026-12-07T10:00:00Z'), frozenUntil: null }],
    waitlist: [{ businessId: 'biz_1', serviceIds: ['sv_1'], wishes: [{ date: '2026-10-10' }], comment: '', bookingId: null, createdAt: d('2026-10-02T10:00:00Z'), clientPhone: '+37400160001', tags: ['SECRET_TAG'] } as never],
    salonCards: [
      {
        businessId: 'biz_1', name: 'Ани', lastName: null, phone: '+37400160001', email: null, birthday: '1995-05-01', gender: 'female', locale: 'hy',
        adConsent: { given: true, at: '2026-09-01T10:00:00.000Z', method: 'app', recordedBy: 'SECRET_STAFF' }, birthdayGreetingOptOut: null, createdAt: d('2026-09-01T10:00:00Z'),
        ...salonSecrets,
      } as never,
    ],
    supportTickets: [{ number: 12, subject: 'Вопрос', message: 'Как отменить?', channel: 'app', topic: 'booking', status: 'answered', messages: [{ id: 'm1', author: 'them', text: 'Как отменить?', at: '2026-10-03T10:00:00.000Z' }, { id: 'm2', author: 'us', text: 'В «Мои записи»', at: '2026-10-03T11:00:00.000Z' }], createdAt: d('2026-10-03T10:00:00Z'), updatedAt: d('2026-10-03T11:00:00Z') }],
    telegram: [{ phone: '+37400160001', languageCode: 'hy', blockedAt: null, createdAt: d('2026-09-10T10:00:00Z'), chatId: 'SECRET_CHAT' } as never],
    demandLeads: [{ query: 'шугаринг', district: 'kentron', notify: true, createdAt: d('2026-09-20T10:00:00Z') }],
  };
}

test('файл «Мои данные» клиента: карты, сертификаты, абонементы, лист ожидания, карточки салонов, согласия', () => {
  const out = buildMyDataExport(clientInput(), d('2026-10-05T12:00:00Z'));
  assert.deepEqual(out.loyaltyCards, [{ business: 'Nuri Nail Studio', cardType: 'Золотая', number: 'C-001', balance: 1200, currency: 'AMD', issuedAt: '2026-09-05T10:00:00.000Z' }]);
  assert.equal(out.certificates[0]!.balance, 4000);
  assert.equal(out.memberships[0]!.remainingVisits, 7);
  assert.deepEqual(out.waitlist[0]!.services, [{ ru: 'Маникюр', en: 'Manicure' }]);
  assert.equal(out.waitlist[0]!.comment, null);
  assert.equal(out.salonCards[0]!.business, 'Nuri Nail Studio');
  assert.deepEqual(out.consents[1], { document: 'salon_ads', business: 'Nuri Nail Studio', given: true, at: '2026-09-01T10:00:00.000Z', method: 'app' });
  assert.deepEqual(out.supportTickets[0]!.messages.map((m) => m.author), ['me', 'support']);
  assert.deepEqual(out.telegram, [{ phone: '+37400160001', language: 'hy', linkedAt: '2026-09-10T10:00:00.000Z', stoppedAt: null }]);
  assert.deepEqual(out.searchRequests, [{ query: 'шугаринг', district: 'kentron', notifyWhenAvailable: true, at: '2026-09-20T10:00:00.000Z' }]);
  assert.deepEqual(out.staffProfiles, []);
});

test('файл «Мои данные» клиента: заметки, теги, поля и файлы салона, chat id Telegram в файл не попадают', () => {
  const json = JSON.stringify(buildMyDataExport(clientInput()));
  assert.doesNotMatch(json, /SECRET/);
  for (const key of ['"note"', '"tags"', 'customFieldValues', 'nationalId', 'avatarUrl', 'importanceClass', 'recordedBy', 'chatId']) {
    assert.ok(!json.includes(key), `нет поля ${key}`);
  }
});

test('без клиентских списков (старый вызов) — пустые массивы, а не ошибка', () => {
  const out = buildMyDataExport(input());
  assert.deepEqual([out.loyaltyCards, out.certificates, out.memberships, out.waitlist, out.salonCards, out.supportTickets, out.telegram, out.searchRequests], [[], [], [], [], [], [], [], []]);
});

test('имя файла — booktime-my-data-ГГГГ-ММ-ДД.json', () => {
  assert.equal(dataExportFilename(d('2026-10-04T23:00:00Z')), 'booktime-my-data-2026-10-04.json');
});
