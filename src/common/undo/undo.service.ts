import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors/api-error.js';
import type { RequestContext } from '../http/context.js';
import { REDIS } from '../tokens.js';

/**
 * «Отменить» (F-00-061, docs/backend/02-api.md §0): опасное обратимое действие (удалить/перенести запись, удалить дни
 * графика) возвращает undoToken; POST /v1/undo/{token} в течение 10 с откатывает. Экран показывает 5 с — запас на сеть.
 * Разделы регистрируют обработчик своего вида: undo.register('booking.delete', async (payload, ctx) => …).
 */
export const UNDO_TTL_SEC = 10;

type UndoHandler = (payload: unknown, ctx: RequestContext) => Promise<void>;

@Injectable()
export class UndoService {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  register(kind: string, handler: UndoHandler): void {
    if (this.handlers.has(kind)) throw new Error(`undo kind already registered: ${kind}`);
    this.handlers.set(kind, handler);
  }

  /** Выдать токен отмены для только что сделанного действия */
  async issue(kind: string, payload: unknown, ctx: RequestContext): Promise<string> {
    if (!this.handlers.has(kind)) throw new Error(`unknown undo kind: ${kind}`);
    const token = randomBytes(18).toString('base64url');
    const owner = ctx.session?.sessionId ?? null;
    await this.redis.set(`undo:${token}`, JSON.stringify({ kind, payload, owner }), 'EX', UNDO_TTL_SEC);
    return token;
  }

  /** Откатить. Токен одноразовый (GETDEL); чужая сессия или истёкший срок — not_found */
  async undo(token: string, ctx: RequestContext): Promise<void> {
    const raw = await this.redis.getdel(`undo:${token}`);
    if (!raw) throw new ApiError('not_found', 'Undo window has passed');
    const { kind, payload, owner } = JSON.parse(raw) as { kind: string; payload: unknown; owner: string | null };
    if (owner !== (ctx.session?.sessionId ?? null)) throw new ApiError('not_found', 'Undo window has passed');
    const handler = this.handlers.get(kind);
    if (!handler) throw new ApiError('not_found', 'Undo window has passed');
    await handler(payload, ctx);
  }
}
