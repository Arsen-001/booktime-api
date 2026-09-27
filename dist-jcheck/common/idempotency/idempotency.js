var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { applyDecorators, Inject, Injectable, SetMetadata, UseInterceptors, } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader } from '@nestjs/swagger';
import { from, of, switchMap, tap } from 'rxjs';
import { ApiError } from '../errors/api-error.js';
import { REDIS } from '../tokens.js';
const FLAG = 'bt:idempotent';
const TTL_SEC = 24 * 3600; // PLAN.md §5: ответ хранится 24 ч
const LOCK_SEC = 60;
/**
 * Идемпотентность (docs/backend/02-api.md §0): создание записи, оплаты, покупка монет, отправка новости. Повтор с тем
 * же Idempotency-Key возвращает первый ответ; пока первый ещё выполняется — 409 conflict. Ключ живёт в пространстве
 * вошедшего (или IP) и конкретного маршрута: чужой ключ ничего не вернёт.
 */
let IdempotencyInterceptor = class IdempotencyInterceptor {
    constructor(reflector, redis) {
        this.reflector = reflector;
        this.redis = redis;
    }
    intercept(host, next) {
        if (!this.reflector.get(FLAG, host.getHandler()))
            return next.handle();
        const req = host.switchToHttp().getRequest();
        const res = host.switchToHttp().getResponse();
        const key = req.header('idempotency-key');
        if (!key)
            return next.handle();
        if (!/^[\w-]{8,100}$/.test(key))
            throw new ApiError('validation', 'Idempotency-Key must be 8–100 chars [A-Za-z0-9_-]');
        const who = req.ctx.session?.sessionId ?? req.ctx.ip;
        const redisKey = `idem:${who}:${req.method}:${req.route?.path ?? req.path}:${key}`;
        return from(this.redis.set(redisKey, JSON.stringify({ state: 'running' }), 'EX', LOCK_SEC, 'NX')).pipe(switchMap((acquired) => {
            if (acquired) {
                return next.handle().pipe(tap({
                    next: (body) => {
                        void this.redis.set(redisKey, JSON.stringify({ state: 'done', status: res.statusCode, body }), 'EX', TTL_SEC);
                    },
                    error: () => {
                        void this.redis.del(redisKey); // ошибку можно повторить с тем же ключом
                    },
                }));
            }
            return from(this.redis.get(redisKey)).pipe(switchMap((raw) => {
                const saved = raw ? JSON.parse(raw) : null;
                if (!saved || saved.state !== 'done')
                    throw new ApiError('conflict', 'The same request is still running');
                res.status(saved.status ?? 200);
                res.setHeader('Idempotent-Replay', 'true');
                return of(saved.body);
            }));
        }));
    }
};
IdempotencyInterceptor = __decorate([
    Injectable(),
    __param(1, Inject(REDIS)),
    __metadata("design:paramtypes", [Reflector, Function])
], IdempotencyInterceptor);
export { IdempotencyInterceptor };
/** @Idempotent() над обработчиком: заголовок Idempotency-Key поддерживается */
export function Idempotent() {
    return applyDecorators(SetMetadata(FLAG, true), UseInterceptors(IdempotencyInterceptor), ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Повтор с тем же ключом вернёт первый ответ (24 ч)' }));
}
//# sourceMappingURL=idempotency.js.map