import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseInterceptors,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { from, of, switchMap, tap, type Observable } from 'rxjs';
import { ApiError } from '../errors/api-error.js';
import type { RequestWithContext } from '../http/context.js';
import { REDIS } from '../tokens.js';

const FLAG = 'bt:idempotent';
const TTL_SEC = 24 * 3600; // PLAN.md §5: ответ хранится 24 ч
const LOCK_SEC = 60;

/**
 * Идемпотентность (docs/backend/02-api.md §0): создание записи, оплаты, покупка монет, отправка новости. Повтор с тем
 * же Idempotency-Key возвращает первый ответ; пока первый ещё выполняется — 409 conflict. Ключ живёт в пространстве
 * вошедшего (или IP) и конкретного маршрута: чужой ключ ничего не вернёт.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  intercept(host: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(FLAG, host.getHandler())) return next.handle();
    const req = host.switchToHttp().getRequest<RequestWithContext>();
    const res = host.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    if (!key) return next.handle();
    if (!/^[\w-]{8,100}$/.test(key)) throw new ApiError('validation', 'Idempotency-Key must be 8–100 chars [A-Za-z0-9_-]');
    const who = req.ctx.session?.sessionId ?? req.ctx.ip;
    const redisKey = `idem:${who}:${req.method}:${req.route?.path ?? req.path}:${key}`;

    return from(this.redis.set(redisKey, JSON.stringify({ state: 'running' }), 'EX', LOCK_SEC, 'NX')).pipe(
      switchMap((acquired) => {
        if (acquired) {
          return next.handle().pipe(
            tap({
              next: (body) => {
                void this.redis.set(redisKey, JSON.stringify({ state: 'done', status: res.statusCode, body }), 'EX', TTL_SEC);
              },
              error: () => {
                void this.redis.del(redisKey); // ошибку можно повторить с тем же ключом
              },
            }),
          );
        }
        return from(this.redis.get(redisKey)).pipe(
          switchMap((raw) => {
            const saved = raw ? (JSON.parse(raw) as { state: string; status?: number; body?: unknown }) : null;
            if (!saved || saved.state !== 'done') throw new ApiError('conflict', 'The same request is still running');
            res.status(saved.status ?? 200);
            res.setHeader('Idempotent-Replay', 'true');
            return of(saved.body);
          }),
        );
      }),
    );
  }
}

/** @Idempotent() над обработчиком: заголовок Idempotency-Key поддерживается */
export function Idempotent() {
  return applyDecorators(
    SetMetadata(FLAG, true),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Повтор с тем же ключом вернёт первый ответ (24 ч)' }),
  );
}
