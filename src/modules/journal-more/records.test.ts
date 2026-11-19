import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDigits, matchClient, parseJournalSearch } from './records.service.js';

// Поиск журнала — те же правила, что parseJournalSearch/matchJournalClient сайта (src/domain/records.ts)
test('поиск журнала: разбор запроса — слова имени и цифры номера без кода страны', () => {
  assert.deepEqual(parseJournalSearch('Арам Кар'), { text: 'арам кар', digits: '' });
  assert.deepEqual(parseJournalSearch('+374 77 55'), { text: '', digits: '7755' });
  assert.deepEqual(parseJournalSearch('077'), { text: '', digits: '77' });
  assert.deepEqual(parseJournalSearch('7'), { text: '', digits: '' });
  assert.deepEqual(parseJournalSearch('Алёна'), { text: 'алена', digits: '' });
});

test('поиск журнала: клиент — по части номера или каждому слову имени', () => {
  const c = { name: 'Арам Карамян', phone: '+37477555171' };
  assert.equal(localDigits(c.phone), '77555171');
  assert.equal(matchClient(c, '', '5551'), true);
  assert.equal(matchClient(c, 'арам кар', ''), true);
  assert.equal(matchClient(c, 'арам зар', ''), false);
  assert.equal(matchClient(c, 'а', ''), false);
});
