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
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors/api-error.js';
import { REDIS } from '../tokens.js';
/**
 * «Отменить» (F-00-061, docs/backend/02-api.md §0): опасное обратимое действие (удалить/перенести запись, удалить дни
 * графика) возвращает undoToken; POST /v1/undo/{token} в течение 10 с откатывает. Экран показывает 5 с — запас на сеть.
 * Разделы регистрируют обработчик своего вида: undo.register('booking.delete', async (payload, ctx) => …).
 */
export const UNDO_TTL_SEC = 10;
let UndoService = class UndoService {
    constructor(redis) {
        this.redis = redis;
        this.handlers = new Map();
    }
    register(kind, handler) {
        if (this.handlers.has(kind))
            throw new Error(`undo kind already registered: ${kind}`);
        this.handlers.set(kind, handler);
    }
    /** Выдать токен отмены для только что сделанного действия */
    async issue(kind, payload, ctx) {
        if (!this.handlers.has(kind))
            throw new Error(`unknown undo kind: ${kind}`);
        const token = randomBytes(18).toString('base64url');
        const owner = ctx.session?.sessionId ?? null;
        await this.redis.set(`undo:${token}`, JSON.stringify({ kind, payload, owner }), 'EX', UNDO_TTL_SEC);
        return token;
    }
    /** Откатить. Токен одноразовый (GETDEL); чужая сессия или истёкший срок — not_found */
    async undo(token, ctx) {
        const raw = await this.redis.getdel(`undo:${token}`);
        if (!raw)
            throw new ApiError('not_found', 'Undo window has passed');
        const { kind, payload, owner } = JSON.parse(raw);
        if (owner !== (ctx.session?.sessionId ?? null))
            throw new ApiError('not_found', 'Undo window has passed');
        const handler = this.handlers.get(kind);
        if (!handler)
            throw new ApiError('not_found', 'Undo window has passed');
        await handler(payload, ctx);
    }
};
UndoService = __decorate([
    Injectable(),
    __param(0, Inject(REDIS)),
    __metadata("design:paramtypes", [Function])
], UndoService);
export { UndoService };
//# sourceMappingURL=undo.service.js.map