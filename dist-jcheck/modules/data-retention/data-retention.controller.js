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
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, Platform } from '../../common/http/guards.js';
import { FullArchiveService } from './full-archive.service.js';
/**
 * Данные и удаление (этап 20, docs/backend/01 §10, 06 §6). Полный архив бизнеса «по запросу» — отдельно от
 * повседневной выгрузки клиентов/записей (`PlatformBusinessesController`, этап 19): тяжелее и реже.
 */
let DataRetentionController = class DataRetentionController {
    constructor(archive) {
        this.archive = archive;
    }
    fullArchive(ctx, id) {
        return this.archive.build(id, ctx.session.userId, 'platform');
    }
};
__decorate([
    Get(':id/full-archive'),
    Platform(),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], DataRetentionController.prototype, "fullArchive", null);
DataRetentionController = __decorate([
    ApiTags('platform-data-retention'),
    Controller('v1/platform/businesses'),
    __metadata("design:paramtypes", [FullArchiveService])
], DataRetentionController);
export { DataRetentionController };
//# sourceMappingURL=data-retention.controller.js.map