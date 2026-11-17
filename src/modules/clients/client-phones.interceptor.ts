import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { RequestWithContext } from '../../common/http/context.js';
/** Та же маска, что в базе клиентов (clients.views maskClientPhones): «+374•••••01» — один вид номера на всех экранах */
const maskPhone = (p: string): string => (p.length > 6 ? `${p.slice(0, 4)}•••••${p.slice(-2)}` : '•••');

/**
 * Ответ 29 (владелец 17.11.2026): «Просматривать телефоны клиентов» — главная галочка. Снята (нет права clients.phones) —
 * телефоны клиентов скрыты в ЛЮБОМ ответе кабинета, не только в базе клиентов: зеркало журнала (карточки клиентов
 * записей — их видел каждый с journal.view, отсюда «телефон клиента в записи» в обход галочки), заявки онлайн-записи,
 * лист ожидания, «кого позвать» и другие строки с полем `clientPhone`. Маска — та же, что в базе клиентов (maskClientPhones).
 */
const MIRROR_PATH = /^\/v1\/biz\/[^/]+\/journal\/mirror/;

export function maskClientPhonesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskClientPhonesDeep);
  // Только простые объекты: файлы (Buffer), потоки и даты отдаём как есть
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Уже замаскированный номер (заказы маскируют сами) второй раз не трогаем
    out[k] = (k === 'clientPhone' || k === 'clientAdditionalPhone') && typeof v === 'string' && v && !v.includes('•') ? maskPhone(v) : maskClientPhonesDeep(v);
  }
  return out;
}

/** Зеркало журнала: `clients[]` — карточки клиентов записей (форма ядра, поле `phone`) */
export function maskMirrorClients<T>(body: T): T {
  const b = body as { clients?: { phone?: string; additionalPhone?: string }[] } | null;
  if (!b || !Array.isArray(b.clients)) return body;
  const mask = (p?: string) => (p && !p.includes('•') ? maskPhone(p) : p);
  return { ...b, clients: b.clients.map((c) => ({ ...c, ...(c.phone ? { phone: mask(c.phone) } : {}), ...(c.additionalPhone ? { additionalPhone: mask(c.additionalPhone) } : {}) })) } as T;
}

@Injectable()
export class ClientPhonesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    return next.handle().pipe(
      map((body) => {
        const member = req?.ctx?.member;
        if (!member || member.permissions.has('clients.phones') || body === undefined || body === null) return body;
        const masked = maskClientPhonesDeep(body);
        return MIRROR_PATH.test(req.path ?? req.url ?? '') ? maskMirrorClients(masked) : masked;
      }),
    );
  }
}
