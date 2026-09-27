import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/** Этап 18: настройки компании, обращения, личные настройки (docs/backend/02 §18) */
@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
