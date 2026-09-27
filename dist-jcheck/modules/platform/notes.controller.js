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
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { PlatformNotesService } from './notes.service.js';
import { platformNotesBody } from './platform.schemas.js';
/** Наша панель: заметки основателя — план запуска, окупаемость, имя (01 §8, docs/backend/02 §19). */
let PlatformNotesController = class PlatformNotesController {
    constructor(notes) {
        this.notes = notes;
    }
    get() {
        return this.notes.getDoc();
    }
    save(body) {
        return this.notes.saveDoc(body);
    }
    payingNow() {
        return this.notes.getPayingNow();
    }
};
__decorate([
    Get(),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformNotesController.prototype, "get", null);
__decorate([
    Put(),
    Platform(),
    __param(0, Body(new Zod(platformNotesBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformNotesController.prototype, "save", null);
__decorate([
    Get('paying-now'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformNotesController.prototype, "payingNow", null);
PlatformNotesController = __decorate([
    ApiTags('platform-notes'),
    Controller('v1/platform/notes'),
    __metadata("design:paramtypes", [PlatformNotesService])
], PlatformNotesController);
export { PlatformNotesController };
//# sourceMappingURL=notes.controller.js.map