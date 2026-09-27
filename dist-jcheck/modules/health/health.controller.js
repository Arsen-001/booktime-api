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
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma.service.js';
import { REDIS } from '../../common/tokens.js';
class HealthDto {
}
__decorate([
    ApiProperty({ enum: ['ok', 'degraded'] }),
    __metadata("design:type", String)
], HealthDto.prototype, "status", void 0);
__decorate([
    ApiProperty(),
    __metadata("design:type", Boolean)
], HealthDto.prototype, "db", void 0);
__decorate([
    ApiProperty(),
    __metadata("design:type", Boolean)
], HealthDto.prototype, "redis", void 0);
__decorate([
    ApiProperty({ description: 'Время сервера, UTC ISO' }),
    __metadata("design:type", String)
], HealthDto.prototype, "time", void 0);
/** Жив ли сервер и его зависимости (для docker/хостинга и ensure-скриптов) */
let HealthController = class HealthController {
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
    }
    async health() {
        const db = await this.prisma.$queryRawUnsafe('SELECT 1').then(() => true, () => false);
        const redis = await this.redis.ping().then((r) => r === 'PONG', () => false);
        return { status: db && redis ? 'ok' : 'degraded', db, redis, time: new Date().toISOString() };
    }
};
__decorate([
    Get(),
    ApiOkResponse({ type: HealthDto }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "health", null);
HealthController = __decorate([
    ApiTags('system'),
    Controller('v1/health'),
    __param(1, Inject(REDIS)),
    __metadata("design:paramtypes", [PrismaService, Function])
], HealthController);
export { HealthController };
//# sourceMappingURL=health.controller.js.map