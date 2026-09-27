var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
const TOKEN_PREFIX = { partner: 'pk_live', userToken: 'utok', aiAssistant: 'ai' };
function sha256(v) {
    return crypto.createHash('sha256').update(v).digest('hex');
}
/**
 * Своё — настоящее (F-13-052/053/071/072, docs/backend/02 §17): секрет генерируется один раз и не
 * восстанавливается — в базе только sha256-хеш + превью последних 4 символов. `KeysTab.tsx`/`McpTab.tsx`
 * фронта всегда маскируют `token` через `maskToken()` перед показом в списке (берёт последние 4 символа),
 * поэтому список отдаёт превью в том же поле `token` — экран не может различить полноценный секрет от
 * превью, и оба честно показывают одинаковый хвост (см. docs/PROGRESS.md, этап 17).
 */
let ApiKeysService = class ApiKeysService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    view(row, rawToken) {
        return {
            id: row.id,
            businessId: row.businessId,
            kind: row.kind,
            label: row.label ?? undefined,
            scope: row.scope ?? undefined,
            token: rawToken ?? `${'•'.repeat(8)}${row.tokenPreview}`,
            createdAt: row.createdAt.toISOString(),
            revokedAt: row.revokedAt?.toISOString(),
        };
    }
    async list(businessId, kind) {
        const rows = await this.prisma.apiKey.findMany({ where: { businessId, kind }, orderBy: { createdAt: 'desc' } });
        return rows.map((r) => this.view(r));
    }
    async issue(ctx, businessId, kind, opts = {}) {
        const raw = `${TOKEN_PREFIX[kind]}_${crypto.randomBytes(24).toString('base64url')}`;
        const id = newId('apiKey');
        const row = await this.prisma.apiKey.create({
            data: {
                id,
                businessId,
                kind,
                label: opts.label ?? null,
                scope: opts.scope ?? null,
                tokenHash: sha256(raw),
                tokenPreview: raw.slice(-4),
                createdBy: ctx.member.staffId,
            },
        });
        return this.view(row, raw);
    }
    async revoke(businessId, id) {
        const row = await this.prisma.apiKey.findFirst({ where: { id, businessId } });
        if (!row)
            throw new ApiError('not_found', 'API key not found');
        if (row.revokedAt)
            return;
        await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    }
};
ApiKeysService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ApiKeysService);
export { ApiKeysService };
//# sourceMappingURL=api-keys.service.js.map