import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sqlLiteral } from './db-backup.js';

test('sqlLiteral: числа, bigint, null, логические', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(Number.NaN), 'NULL');
  assert.equal(sqlLiteral(12345678901234567890n), '12345678901234567890');
  assert.equal(sqlLiteral(true), '1');
});

test('sqlLiteral: дата — UTC с миллисекундами', () => {
  assert.equal(sqlLiteral(new Date('2026-10-03T04:05:06.007Z')), "'2026-10-03 04:05:06.007'");
});

test('sqlLiteral: строки экранируются, JSON и бинарные данные', () => {
  assert.equal(sqlLiteral("O'Brien \\ \n"), "'O\\'Brien \\\\ \\n'");
  assert.equal(sqlLiteral({ a: "it's" }), `'{"a":"it\\'s"}'`);
  assert.equal(sqlLiteral(Buffer.from([0xde, 0xad])), "X'dead'");
  assert.equal(sqlLiteral('Анна'), "'Анна'");
});
