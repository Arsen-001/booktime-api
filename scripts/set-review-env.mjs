#!/usr/bin/env node
/**
 * Вход проверяющих магазинов (docs/store/review-notes.md в booking-platform) → переменные сервиса api на Railway.
 * Запускает владелец, одной короткой строкой:
 *   node scripts/set-review-env.mjs staging
 *   node scripts/set-review-env.mjs production
 * Берёт из ~/.booktime-secrets/review-login.env: REVIEW_LOGIN_PHONES и STAGING_/PRODUCTION_REVIEW_LOGIN_CODE.
 * Пишет REVIEW_LOGIN_PHONES и REVIEW_LOGIN_CODE (src/common/config/env.ts); код не печатает. Railway перезапускает api.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.argv[2];
if (!['staging', 'production'].includes(env)) {
  console.error('Использование: node scripts/set-review-env.mjs staging|production');
  process.exit(1);
}
const file = join(homedir(), '.booktime-secrets', 'review-login.env');
const vars = Object.fromEntries(
  readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const phones = vars.REVIEW_LOGIN_PHONES;
const code = vars[`${env.toUpperCase()}_REVIEW_LOGIN_CODE`];
if (!phones || !/^\d{4}$/.test(code ?? '')) {
  console.error(`В ${file} нет REVIEW_LOGIN_PHONES или ${env.toUpperCase()}_REVIEW_LOGIN_CODE (4 цифры)`);
  process.exit(1);
}
// Railway привязан к папке сервера (railway link) — запускаем оттуда, откуда бы ни вызвали скрипт.
// Ошибку печатаем своими словами: в аргументах команды есть код, его нельзя выводить.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  execFileSync('railway', ['variables', '-s', 'api', '-e', env, '--set', `REVIEW_LOGIN_PHONES=${phones}`, '--set', `REVIEW_LOGIN_CODE=${code}`], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (err) {
  const reason = String(err.stderr ?? '').replaceAll(code, '••••').trim().split('\n').slice(0, 3).join('\n');
  console.error(`✗ ${env}: Railway не принял переменные. ${reason || 'Проверьте: railway whoami, railway link в booktime-backend.'}`);
  process.exit(1);
}
console.log(`✓ ${env}: REVIEW_LOGIN_PHONES=${phones}, REVIEW_LOGIN_CODE задан (не печатается)`);
