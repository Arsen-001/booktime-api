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
import { Controller, Inject, Query, Sse } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { interval, map, merge } from 'rxjs';
import { ApiError } from '../errors/api-error.js';
import { Authed, Ctx } from '../http/guards.js';
import { LiveService } from './live.service.js';
export const LIVE_ACCESS = Symbol('LIVE_ACCESS');
export const ownChannelsOnly = { canSubscribe: async () => false };
const CHANNEL_RE = /^(biz:[\w-]+:day:\d{4}-\d{2}-\d{2}|staff:[\w-]+|me)$/;
const MAX_CHANNELS = 20;
let LiveController = class LiveController {
    constructor(live, access) {
        this.live = live;
        this.access = access;
    }
    /** SSE: /v1/live?channels=me,biz:biz_1:day:2026-09-27 — события перечитывания; комментарий-пульс каждые 25 с */
    async subscribe(raw, ctx) {
        const requested = [...new Set((raw ?? 'me').split(',').map((s) => s.trim()).filter(Boolean))];
        if (requested.length > MAX_CHANNELS)
            throw new ApiError('validation', `At most ${MAX_CHANNELS} channels`);
        const channels = [];
        for (const ch of requested) {
            if (!CHANNEL_RE.test(ch))
                throw new ApiError('validation', `Unknown channel: ${ch}`);
            if (ch === 'me')
                channels.push(`user:${ctx.session.userId}`);
            else if (await this.access.canSubscribe(ctx, ch))
                channels.push(ch);
            else
                throw new ApiError('forbidden', `Channel is not accessible: ${ch}`);
        }
        const events = this.live
            .stream(channels)
            .pipe(map(({ channel, event }) => ({ type: event.type, data: { channel: channel.startsWith('user:') ? 'me' : channel, ...event.data } })));
        const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: {} })));
        return merge(events, heartbeat);
    }
};
__decorate([
    Sse(),
    Authed(),
    ApiQuery({ name: 'channels', description: 'Через запятую: me, staff:{id}, biz:{id}:day:{YYYY-MM-DD}' }),
    __param(0, Query('channels')),
    __param(1, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], LiveController.prototype, "subscribe", null);
LiveController = __decorate([
    ApiTags('system'),
    Controller('v1/live'),
    __param(1, Inject(LIVE_ACCESS)),
    __metadata("design:paramtypes", [LiveService, Object])
], LiveController);
export { LiveController };
//# sourceMappingURL=live.controller.js.map