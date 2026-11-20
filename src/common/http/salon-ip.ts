import { BlockList, isIP } from 'node:net';
import { env } from '../config/env.js';

/**
 * «Вход только с IP салона» (20.11.2026, DESIGN.md сайта ответ 22): адреса, сети и настоящий адрес клиента. Те же правила
 * у мока сайта (booking-platform src/domain/staff.ts: ipAllowedBy, salonAddressFor) — тесты с обеих сторон на одних примерах.
 */

/** '::ffff:37.252.64.10' → '37.252.64.10'; IPv6 — строчными; пробелы по краям прочь */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  return mapped ? mapped[1]! : ip;
}

/** Адрес или сеть: '37.252.64.10', '37.252.64.0/24', '2a00:cc0:1:2::/64' */
export function isValidIpRange(range: string): boolean {
  const parts = range.trim().split('/');
  if (parts.length > 2) return false;
  const [base, prefix] = parts as [string, string | undefined];
  const v = isIP(normalizeIp(base));
  if (!v) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v === 4 ? 32 : 128);
}

/** Пускает ли список салона этот адрес: точное совпадение или адрес внутри сети /N. Ошибочные строки списка пропускаются */
export function ipAllowedBy(ranges: readonly string[], rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  const v = isIP(ip);
  if (!v) return false;
  const list = new BlockList();
  for (const r of ranges) {
    if (!isValidIpRange(r)) continue;
    const [rawBase, prefix] = r.trim().split('/') as [string, string | undefined];
    const base = normalizeIp(rawBase);
    const type = isIP(base) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(base, type);
    else list.addSubnet(base, Number(prefix), type);
  }
  return list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/** 8 групп IPv6 ('2a00:cc0:1:2:a:b:c:d' и '2a00:cc0::1') — числами; не IPv6 — null */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? (s.split('::') as [string, string]) : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
}

/**
 * Что добавить в список салона по кнопке «Добавить этот адрес»: IPv4 — сам адрес; IPv6 — его сеть /64 (телефон и
 * ноутбук в той же сети салона меняют последние 64 бита адреса каждый день, сеть провайдера у салона — одна).
 * '2a00:cc0:1:2:a:b:c:d' → '2a00:cc0:1:2::/64'. Не адрес — null.
 */
export function salonAddressFor(rawIp: string): string | null {
  const ip = normalizeIp(rawIp);
  const v = isIP(ip);
  if (v === 4) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : null;
}

/** Нужное от запроса Express: заголовок, req.ip и адрес соединения */
export interface IpRequest {
  header(name: string): string | undefined;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Настоящий адрес клиента (20.11.2026). Путь запроса: браузер → край Railway → наш сервер. DNS booktime.am — у Vercel,
 * `api` — простой CNAME на Railway, без прокси Vercel или Cloudflare; кабинет зовёт API прямо из браузера (src/api/http.ts
 * сайта), поэтому адрес, с которым край Railway говорит, — адрес человека.
 *  - Край Railway ставит X-Real-IP — «client's remote IP» (docs.railway.com, Public Networking → Specs & Limits). Ему
 *    верим, только когда сервер за прокси (TRUST_PROXY задан — так на Railway).
 *  - X-Forwarded-For не читаем напрямую: его может прислать сам клиент («я из салона»). Если X-Real-IP нет — req.ip
 *    Express с trust proxy = TRUST_PROXY, то есть адрес, дописанный нашим прокси последним, а не первый из списка.
 *  - Локально (TRUST_PROXY пуст) — адрес соединения, заголовки не читаем вовсе.
 */
export function clientIp(req: IpRequest, trustProxy: number | undefined = env.TRUST_PROXY): string {
  if (trustProxy) {
    const real = normalizeIp(req.header('x-real-ip') ?? '');
    if (isIP(real)) return real;
  }
  return normalizeIp(req.ip ?? req.socket?.remoteAddress ?? '');
}
