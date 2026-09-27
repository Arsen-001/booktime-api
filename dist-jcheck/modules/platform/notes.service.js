var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
const DEFAULT_DOC = {
    waveItems: [],
    prelaunchItems: [],
    paybackInputs: { monthlyCosts: 800_000, individualPrice: 5000, salonPerMaster: 4000, avgMasters: 4, discountShare: 30, discountPercent: 15, targetNet: 500_000, usdRate: 363, eurRate: 430 },
    nameCandidates: [],
    brand: {},
};
/**
 * Заметки основателя — план запуска, окупаемость, имя (01 §8, F-00-203…208, docs/backend/02 §19: «…/notes,
 * одним документом»). Рабочий документ, не продуктовая функция конечных пользователей — см. PROGRESS.md.
 */
let PlatformNotesService = class PlatformNotesService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getDoc() {
        const row = await this.prisma.platformNotes.findUnique({ where: { id: 'singleton' } });
        if (!row)
            return DEFAULT_DOC;
        return { ...DEFAULT_DOC, ...row.data };
    }
    async saveDoc(patch) {
        const current = await this.getDoc();
        const next = { ...current, ...patch };
        const data = next;
        await this.prisma.platformNotes.upsert({ where: { id: 'singleton' }, update: { data }, create: { id: 'singleton', data } });
        return next;
    }
    /** «Сейчас платят» (F-00-206) — из реальных подписок, не вводим руками: Subscription.status === 'active' */
    async getPayingNow() {
        const subs = await this.prisma.subscription.findMany({ where: { status: 'active' }, select: { businessId: true } });
        const businesses = await this.prisma.business.findMany({ where: { id: { in: subs.map((s) => s.businessId) } }, select: { kind: true } });
        let salons = 0;
        let individuals = 0;
        for (const b of businesses) {
            if (b.kind === 'individual')
                individuals += 1;
            else
                salons += 1;
        }
        return { salons, individuals };
    }
};
PlatformNotesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], PlatformNotesService);
export { PlatformNotesService };
//# sourceMappingURL=notes.service.js.map