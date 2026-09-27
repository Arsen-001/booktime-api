var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { DataRetentionController } from './data-retention.controller.js';
import { FullArchiveService } from './full-archive.service.js';
/** Этап 20 — данные и удаление (docs/backend/01 §10, 06 §6): полный архив бизнеса по запросу. */
let DataRetentionModule = class DataRetentionModule {
};
DataRetentionModule = __decorate([
    Module({
        controllers: [DataRetentionController],
        providers: [FullArchiveService],
    })
], DataRetentionModule);
export { DataRetentionModule };
//# sourceMappingURL=data-retention.module.js.map