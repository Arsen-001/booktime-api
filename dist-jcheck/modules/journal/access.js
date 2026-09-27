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
import { MEMBERSHIP_RESOLVER } from '../../common/http/resolvers.js';
/**
 * «Все филиалы» (F-01-006, F-00-050): журнал сети смотрит записи нескольких бизнесов. Бизнес из пути уже проверен
 * BizGuard; остальные из ?businessIds= берутся, только если у вошедшего и там есть членство с journal.view.
 */
let JournalAccess = class JournalAccess {
    constructor(memberships) {
        this.memberships = memberships;
    }
    async businessIds(ctx, raw) {
        const own = ctx.member.businessId;
        const list = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
        const out = [own];
        for (const id of new Set(list)) {
            if (id === own || !ctx.session)
                continue;
            const m = await this.memberships.resolve(ctx.session, id);
            if (m?.permissions.has('journal.view'))
                out.push(id);
        }
        return out;
    }
};
JournalAccess = __decorate([
    Injectable(),
    __param(0, Inject(MEMBERSHIP_RESOLVER)),
    __metadata("design:paramtypes", [Object])
], JournalAccess);
export { JournalAccess };
export const csv = (v) => (Array.isArray(v) ? v.join(',') : (v ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
//# sourceMappingURL=access.js.map