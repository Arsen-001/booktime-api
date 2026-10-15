/**
 * Сертификаты (QA приложений 15.10.2026, port/extra-ops.ts): тип сертификата архивируется, как типы карт и абонементов
 * (архивный не продаётся ни в кассе, ни онлайн; «Вернуть из архива» снимает флаг); хаб «продано N, на X» — без
 * отменённых продаж и возвратов. Состояние лояльности — в памяти (runInPort). Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { runInPort } = await import('./port/shim.js');
const { emptyState } = await import('./port/state.js');
const extra = await import('./port/extra-ops.js');
const logic = await import('./port/logic.js');
const { BIZ_OPS } = await import('./port/ops.js');
const { REQUIRED_ARGS } = await import('./port/arity.js');

type State = ReturnType<typeof emptyState>;

function certType(id: string, extraFields: Record<string, unknown> = {}) {
  return {
    id,
    businessId: 'biz_1',
    name: `Тип ${id}`,
    nominal: 10000,
    chargeType: 'multiple',
    category: 'none',
    applyServicesMode: 'all',
    applyProductsAllowed: true,
    expiryMode: 'none',
    allowNoCode: true,
    editLocationsMode: 'none',
    onlineSale: { enabled: true },
    locationIds: [],
    createdAt: '2026-10-01T10:00',
    ...extraFields,
  };
}

function cert(id: string, status: string, balance: number, extraFields: Record<string, unknown> = {}) {
  return { id, businessId: 'biz_1', certTypeId: 'ctt_1', code: id, nominal: 10000, balance, status, locationId: 'loc_1', soldAt: '2026-10-01T10:00', ...extraFields };
}

// Контекст порта на состояние: mutateArea заменяет ctx.state копией — следующие вызовы видят правку
const contexts = new WeakMap<State, { state: State; core: never }>();
function run<T>(state: State, fn: () => Promise<T>): Promise<T> {
  let ctx = contexts.get(state);
  if (!ctx) contexts.set(state, (ctx = { state, core: { clients: [], locations: [], staff: [], services: [], bookings: [] } as never }));
  return runInPort(ctx, fn);
}

test('хаб: отменённая продажа и полный возврат не считаются, частичный возврат вычитается из суммы', async () => {
  const state = emptyState();
  state.certificateTypes.push(certType('ctt_1') as never);
  state.certificates.push(
    cert('c_ok', 'active', 10000, { clientId: 'cl_1' }) as never,
    cert('c_used', 'used', 0, { clientId: 'cl_1' }) as never,
    cert('c_void', 'expired', 0) as never, // «Отменить продажу» снимает клиента и баланс
    cert('c_refund_full', 'expired', 0, { clientId: 'cl_2' }) as never,
    cert('c_refund_part', 'active', 7000, { clientId: 'cl_3' }) as never,
  );
  state.transactions.push(
    { id: 't1', businessId: 'biz_1', locationId: 'loc_1', type: 'certificateRefund', clientId: 'cl_2', certificateId: 'c_refund_full', amount: -10000, createdAt: '2026-10-02T10:00' } as never,
    { id: 't2', businessId: 'biz_1', locationId: 'loc_1', type: 'certificateRefund', clientId: 'cl_3', certificateId: 'c_refund_part', amount: -3000, createdAt: '2026-10-02T10:00' } as never,
  );
  const r = await run(state, () => extra.getLoyaltyHubOverview('biz_1'));
  assert.equal(r.certificates.count, 3);
  assert.equal(r.certificates.sum, 10000 + 10000 + 7000);
  assert.equal(r.certificates.hasTypes, true);
  // Фасад фронта считал все пять — разница именно в отменённых/возвращённых
  const raw = await run(state, () => logic.getLoyaltyHubOverview('biz_1'));
  assert.equal(raw.certificates.count, 5);
});

test('хаб: продажа, отменённая через voidCertificateSale, пропадает из «продано»', async () => {
  const state = emptyState();
  state.certificateTypes.push(certType('ctt_1') as never);
  state.certificates.push(cert('c_1', 'active', 10000, { clientId: 'cl_1' }) as never, cert('c_2', 'active', 10000, { clientId: 'cl_1' }) as never);
  await run(state, () => logic.voidCertificateSale('biz_1', 'c_2'));
  const r = await run(state, () => extra.getLoyaltyHubOverview('biz_1'));
  assert.equal(r.certificates.count, 1);
  assert.equal(r.certificates.sum, 10000);
});

test('тип сертификата: в архив и обратно; архивный не продаётся и не виден на онлайн-витрине', async () => {
  const state = emptyState();
  state.certificateTypes.push(certType('ctt_1') as never, certType('ctt_2') as never);
  const archived = await run(state, () => extra.setCertificateTypeArchived('biz_1', 'ctt_1', true));
  assert.equal((archived as { archived?: boolean }).archived, true);
  const rows = await run(state, () => logic.listCertificateTypes('biz_1'));
  assert.equal((rows.find((t) => t.id === 'ctt_1') as { archived?: boolean }).archived, true);

  await assert.rejects(run(state, () => extra.sellCertificate('biz_1', { certTypeId: 'ctt_1', clientId: 'cl_1', locationId: 'loc_1' })), (e: unknown) => (e as { code?: string }).code === 'validation');
  const catalog = await run(state, () => extra.listOnlineSaleCatalog('biz_1'));
  assert.deepEqual(catalog.filter((i) => i.kind === 'certificate').map((i) => i.typeId), ['ctt_2']);
  await assert.rejects(
    run(state, () => extra.createOnlineOrder('biz_1', { itemKind: 'certificate', itemTypeId: 'ctt_1', clientName: 'Ани', clientPhone: '+37491000000', locationId: 'loc_1' } as never)),
    (e: unknown) => (e as { code?: string }).code === 'not_found',
  );

  const back = await run(state, () => extra.setCertificateTypeArchived('biz_1', 'ctt_1', false));
  assert.equal((back as { archived?: boolean }).archived, undefined);
  const sold = await run(state, () => extra.sellCertificate('biz_1', { certTypeId: 'ctt_1', clientId: 'cl_1', locationId: 'loc_1' }));
  assert.equal(sold.certTypeId, 'ctt_1');
});

test('тип сертификата: чужой бизнес — not_found; операция доступна по сети с правом loyalty.manage', async () => {
  const state = emptyState();
  state.certificateTypes.push(certType('ctt_1') as never);
  await assert.rejects(run(state, () => extra.setCertificateTypeArchived('biz_2', 'ctt_1', true)), (e: unknown) => (e as { code?: string }).code === 'not_found');
  assert.deepEqual(BIZ_OPS.setCertificateTypeArchived, ['loyalty.manage']);
  assert.deepEqual(REQUIRED_ARGS.setCertificateTypeArchived, ['string', 'string', 'boolean']);
});
