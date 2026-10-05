/** F-00-047: домашняя запись в часы смены салона с галочкой владельца. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findHomeShiftConflict, isHomeWorkplace, shiftOverlap, type ShiftSchedule } from './home-shift.js';
import { localToUtc } from '../../common/time/time.js';

const day = (from: string, to: string) => [{ from, to }];
// 2026-10-07 — среда (0 = пн → индекс 2)
const salon: ShiftSchedule = { workplace: 'salon', week: { '2': day('10:00', '14:00') }, overrides: {}, openUntil: null };
const home: ShiftSchedule = { workplace: 'home', week: { '2': day('08:00', '22:00') }, overrides: {}, openUntil: null };
const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

test('домашняя запись — дома и выезд; салон и онлайн — нет', () => {
  assert.equal(isHomeWorkplace('home'), true);
  assert.equal(isHomeWorkplace('visit'), true);
  assert.equal(isHomeWorkplace('salon'), false);
  assert.equal(isHomeWorkplace(null), false);
});

test('пересечение со сменой: внутри, на краю, касание концами', () => {
  assert.deepEqual(shiftOverlap([salon], '2026-10-07', m('13:00'), m('15:00')), { from: m('10:00'), to: m('14:00') });
  assert.equal(shiftOverlap([salon], '2026-10-07', m('14:00'), m('15:00')), null, 'смена до 14:00, запись с 14:00 — можно');
  assert.equal(shiftOverlap([salon], '2026-10-07', m('09:00'), m('10:00')), null);
  assert.equal(shiftOverlap([salon], '2026-10-08', m('11:00'), m('12:00')), null, 'в четверг смены нет');
});

test('домашний график — не смена; исключение на дату и «открыт до» учитываются', () => {
  assert.equal(shiftOverlap([home], '2026-10-07', m('11:00'), m('12:00')), null);
  assert.equal(shiftOverlap([{ ...salon, overrides: { '2026-10-07': [] } }], '2026-10-07', m('11:00'), m('12:00')), null, 'выходной по исключению');
  assert.ok(shiftOverlap([{ ...salon, overrides: { '2026-10-08': day('16:00', '18:00') } }], '2026-10-08', m('17:00'), m('17:30')));
  assert.equal(shiftOverlap([{ ...salon, openUntil: '2026-10-06' }], '2026-10-07', m('11:00'), m('12:00')), null);
});

// ─── поиск по базе: фейковая транзакция (только нужные запросы) ───

interface FakeStaff { id: string; businessId: string; userId: string | null; status?: string }
function fakeTx(o: { staff: FakeStaff[]; strict: string[]; schedules: { staffId: string; workplace: string; week: Record<string, { from: string; to: string }[]> }[] }) {
  const inList = (v: unknown, w: { in?: string[]; notIn?: string[] } | string | undefined) =>
    w === undefined ? true : typeof w === 'string' ? v === w : (w.in ? w.in.includes(v as string) : true) && (w.notIn ? !w.notIn.includes(v as string) : true);
  return {
    staff: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; OR?: Record<string, { in: string[] }>[]; status?: string } }) =>
        o.staff.filter((s) => {
          if (where.id && !where.id.in.includes(s.id)) return false;
          if (where.OR && !where.OR.some((c) => Object.entries(c).every(([k, v]) => v.in.includes((s as unknown as Record<string, string>)[k] ?? '')))) return false;
          if (where.status && (s.status ?? 'active') !== where.status) return false;
          return true;
        }),
    },
    business: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => o.strict.includes(id)).map((id) => ({ id })) },
    workSchedule: {
      findMany: async ({ where }: { where: { staffId: { in: string[] }; workplace: { notIn: string[] } } }) =>
        o.schedules
          .filter((s) => inList(s.staffId, where.staffId) && inList(s.workplace, where.workplace))
          .map((s) => ({ ...s, locationId: 'loc', openUntil: null, days: [] })),
    },
    location: { findMany: async () => [{ id: 'loc', tz: 'Asia/Yerevan' }] },
  } as never;
}

const at = (local: string) => localToUtc(local, 'Asia/Yerevan');
const people: FakeStaff[] = [
  { id: 'st_salon_ani', businessId: 'biz_salon', userId: 'u_ani' },
  { id: 'st_own_ani', businessId: 'biz_ani', userId: 'u_ani' },
];
const schedules = [
  { staffId: 'st_salon_ani', workplace: 'salon', week: { '2': day('10:00', '14:00') } },
  { staffId: 'st_own_ani', workplace: 'home', week: { '2': day('08:00', '22:00') } },
];

test('домашняя запись в своём бизнесе на смену в салоне с галочкой — конфликт', async () => {
  const tx = fakeTx({ staff: people, strict: ['biz_salon'], schedules });
  const clash = await findHomeShiftConflict(tx, { staffIds: ['st_own_ani'], workplace: 'home', startAt: at('2026-10-07T13:00'), endAt: at('2026-10-07T14:30') });
  assert.deepEqual(clash, { businessId: 'biz_salon', staffId: 'st_salon_ani', date: '2026-10-07', from: '10:00', to: '14:00' });
});

test('без галочки, после смены, в салоне — можно', async () => {
  const noFlag = fakeTx({ staff: people, strict: [], schedules });
  assert.equal(await findHomeShiftConflict(noFlag, { staffIds: ['st_own_ani'], workplace: 'home', startAt: at('2026-10-07T13:00'), endAt: at('2026-10-07T14:00') }), null);
  const tx = fakeTx({ staff: people, strict: ['biz_salon'], schedules });
  assert.equal(await findHomeShiftConflict(tx, { staffIds: ['st_own_ani'], workplace: 'visit', startAt: at('2026-10-07T14:00'), endAt: at('2026-10-07T15:00') }), null);
  assert.equal(await findHomeShiftConflict(tx, { staffIds: ['st_salon_ani'], workplace: 'salon', startAt: at('2026-10-07T11:00'), endAt: at('2026-10-07T12:00') }), null);
});

test('уволенная карточка в салоне смены не даёт; домашний график в салоне — сам не смена', async () => {
  const fired = fakeTx({ staff: [{ ...people[0]!, status: 'fired' }, people[1]!], strict: ['biz_salon'], schedules });
  assert.equal(await findHomeShiftConflict(fired, { staffIds: ['st_own_ani'], workplace: 'home', startAt: at('2026-10-07T11:00'), endAt: at('2026-10-07T12:00') }), null);
  // Мастер салона с домашним графиком в том же салоне: домашняя запись в 11:00 — на смене, 16:00 — после неё
  const same = fakeTx({
    staff: [{ id: 'st_nuri_ani', businessId: 'biz_nuri', userId: null }],
    strict: ['biz_nuri'],
    schedules: [
      { staffId: 'st_nuri_ani', workplace: 'salon', week: { '2': day('10:00', '14:00') } },
      { staffId: 'st_nuri_ani', workplace: 'home', week: { '2': day('15:00', '20:00') } },
    ],
  });
  assert.ok(await findHomeShiftConflict(same, { staffIds: ['st_nuri_ani'], workplace: 'home', startAt: at('2026-10-07T11:00'), endAt: at('2026-10-07T12:00') }));
  assert.equal(await findHomeShiftConflict(same, { staffIds: ['st_nuri_ani'], workplace: 'home', startAt: at('2026-10-07T16:00'), endAt: at('2026-10-07T17:00') }), null);
});
