#!/usr/bin/env node
/**
 * Ключ Firebase для уведомлений (FCM HTTP v1) → переменные сервиса api на Railway. Запускает владелец:
 *   node scripts/set-fcm-env.mjs ~/Downloads/booktime-47539-firebase-adminsdk-xxxx.json staging
 *   node scripts/set-fcm-env.mjs <тот же файл> production
 * Файл — Firebase → Project settings → Service accounts → Generate new private key (проект booktime-47539).
 * Пишет FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY (src/common/config/env.ts); сам ключ не печатает.
 * После записи Railway перезапускает api. Файл ключа потом сохраните в менеджере паролей и удалите из «Загрузок».
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, env] = process.argv.slice(2);
if (!file || !['staging', 'production'].includes(env)) {
  console.error('Использование: node scripts/set-fcm-env.mjs <файл ключа .json> staging|production');
  process.exit(1);
}
const key = JSON.parse(readFileSync(file, 'utf8'));
if (key.type !== 'service_account' || !key.project_id || !key.client_email || !key.private_key) {
  console.error('Это не ключ сервисного аккаунта Firebase (нужны type=service_account, project_id, client_email, private_key)');
  process.exit(1);
}
execFileSync(
  'railway',
  [
    'variables',
    '-s', 'api',
    '-e', env,
    '--set', `FCM_PROJECT_ID=${key.project_id}`,
    '--set', `FCM_CLIENT_EMAIL=${key.client_email}`,
    '--set', `FCM_PRIVATE_KEY=${key.private_key}`,
  ],
  // Railway привязан к папке сервера — запускаем оттуда, откуда бы ни вызвали скрипт
  { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'), stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log(`✓ ${env}: FCM_PROJECT_ID=${key.project_id}, FCM_CLIENT_EMAIL=${key.client_email}, FCM_PRIVATE_KEY задан (не печатается)`);
