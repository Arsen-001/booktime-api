/**
 * Правка шаблона уведомления по одному каналу (проход 17.11): «Сохранить» во вкладке «Шаблоны» отвечало 400 —
 * z.record с ключом-перечислением в zod 4 требует все каналы (adminApp, email, sms…). Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateTypeBody } from './notify.schemas.js';

test('шаблон одного канала проходит проверку', () => {
  const r = updateTypeBody.safeParse({ code: 8, patch: { templates: { push: { ru: '{companyName}: вас записали — {service}. Ждём вас!' } } } });
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('неизвестный канал — ошибка', () => {
  const r = updateTypeBody.safeParse({ code: 8, patch: { templates: { pigeon: { ru: 'x' } } } });
  assert.equal(r.success, false);
});
