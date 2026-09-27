var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { AccountController } from '../account/account.controller.js';
import { AccountService } from '../account/account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OtpService } from './otp.service.js';
/** Этап 2: вход (код, пароль администратора, второй шаг, команда платформы), сессии, аккаунт */
let AuthModule = class AuthModule {
};
AuthModule = __decorate([
    Module({
        controllers: [AuthController, AccountController],
        providers: [OtpService, AuthService, AccountService],
        exports: [OtpService, AuthService],
    })
], AuthModule);
export { AuthModule };
//# sourceMappingURL=auth.module.js.map