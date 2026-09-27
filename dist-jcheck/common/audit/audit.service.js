var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@nestjs/common';
import { newId } from '../ids/ids.js';
import { fanOutWebhooks } from './webhook-fanout.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SKIP = new Set(['updatedAt', 'updated_at', 'version']);
export function diffOf(before, after) {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    const diff = {};
    for (const k of keys) {
        if (SKIP.has(k))
            continue;
        const a = before?.[k] ?? null;
        const b = after?.[k] ?? null;
        if (!same(a, b))
            diff[k] = [a, b];
    }
    return Object.keys(diff).length ? diff : null;
}
const PHONE_KEYS = /phone/i;
/** Для читателя без права clients.phones: телефоны в diff маскируются, как на экранах (утечку F-10-093 не повторять) */
export function maskPhonesInDiff(diff) {
    if (!diff)
        return diff;
    const mask = (v) => (typeof v === 'string' && v.length > 4 ? `${v.slice(0, 4)}•••••${v.slice(-2)}` : v);
    return Object.fromEntries(Object.entries(diff).map(([k, [a, b]]) => [k, PHONE_KEYS.test(k) ? [mask(a), mask(b)] : [a, b]]));
}
/** Кто действует — из контекста запроса */
export function actorOf(ctx) {
    if (!ctx)
        return { actorType: 'system', actorId: null, actorName: 'system' };
    if (ctx.member)
        return { actorType: 'staff', actorId: ctx.member.staffId, actorName: ctx.member.name };
    if (ctx.session?.platform)
        return { actorType: 'platform', actorId: ctx.session.userId, actorName: 'platform' };
    if (ctx.session)
        return { actorType: 'client', actorId: ctx.session.userId, actorName: 'client' };
    return { actorType: 'link_holder', actorId: null, actorName: 'link_holder' };
}
let AuditService = class AuditService {
    /** Записать событие в ТОЙ ЖЕ транзакции, что и правка: await audit.record(tx, ctx, { … }) */
    async record(tx, ctx, input) {
        const diff = diffOf(input.before, input.after);
        if (input.action === 'update' && !diff)
            return; // сохранили без изменений — строки не нужно
        await tx.auditEvent.create({
            data: {
                id: newId('auditEvent'),
                businessId: input.businessId ?? ctx?.member?.businessId ?? null,
                networkId: input.networkId ?? null,
                ...actorOf(ctx),
                action: input.action,
                entityType: input.entityType,
                entityId: input.entityId,
                diff: (diff ?? undefined),
                requestId: ctx?.requestId ?? null,
                ip: ctx?.ip ?? null,
                device: ctx?.device ?? null,
            },
        });
        // Этап 17: одна и та же транзакция — доставка вебхука коммитится, только если коммитится сама правка
        await fanOutWebhooks(tx, input.businessId ?? ctx?.member?.businessId ?? null, input);
    }
};
AuditService = __decorate([
    Injectable()
], AuditService);
export { AuditService };
//# sourceMappingURL=audit.service.js.map