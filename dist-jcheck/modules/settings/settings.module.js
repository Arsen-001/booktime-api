var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
/** Этап 18: настройки компании, обращения, личные настройки (docs/backend/02 §18) */
let SettingsModule = class SettingsModule {
};
SettingsModule = __decorate([
    Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
], SettingsModule);
export { SettingsModule };
//# sourceMappingURL=settings.module.js.map