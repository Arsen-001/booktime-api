import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Шифрование секретов в базе (04.10.2026): AES-256-GCM ключом SECRETS_KEY. Сейчас — refresh token «Войти через Apple»
 * (нужен только чтобы отозвать вход при удалении аккаунта). Формат строки: `v1.<iv>.<tag>.<шифртекст>` (base64url).
 * Утечка дампа базы без ключа токенов не раскрывает; подмена строки — ошибка расшифровки (GCM проверяет целостность).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new RangeError('SecretBox key must be 32 bytes');
    this.key = key;
  }

  /** Ключ из переменной: 32 байта в base64 / base64url / hex; любая другая строка — sha256 от неё (не пусто) */
  static fromEnv(value: string | undefined): SecretBox | null {
    const v = value?.trim();
    if (!v) return null;
    if (/^[0-9a-fA-F]{64}$/.test(v)) return new SecretBox(Buffer.from(v, 'hex'));
    const b64 = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b64.length === 32 && /^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(v)) return new SecretBox(b64);
    return new SecretBox(createHash('sha256').update(v).digest());
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  /** Расшифровать; чужой ключ, испорченная строка — null */
  open(sealed: string): string | null {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
