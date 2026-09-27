import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Пароли — argon2id (docs/backend/03 §6) встроенным node:crypto (Node ≥ 24.7), без нативных пакетов.
 * Формат PHC: $argon2id$v=19$m=19456,t=2,p=1$<соль>$<хэш> (base64 без «=»), параметры — минимум OWASP.
 */
const run = promisify(argon2);
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const tag = await run('argon2id', { message: password, nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(tag)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const tag = await run('argon2id', {
    message: password,
    nonce: Buffer.from(m[4]!, 'base64'),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(tag, expected);
}

/** Правило нового пароля (как во фронте, changeAdminPassword): от 6 символов и не совпадает с логином */
export function isWeakPassword(password: string, login: string): boolean {
  return password.length < 6 || password.length > 128 || password.trim().toLowerCase() === login.trim().toLowerCase();
}
