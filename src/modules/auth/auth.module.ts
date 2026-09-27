import { Module } from '@nestjs/common';
import { AccountController } from '../account/account.controller.js';
import { AccountService } from '../account/account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OtpService } from './otp.service.js';

/** Этап 2: вход (код, пароль администратора, второй шаг, команда платформы), сессии, аккаунт */
@Module({
  controllers: [AuthController, AccountController],
  providers: [OtpService, AuthService, AccountService],
  exports: [OtpService, AuthService],
})
export class AuthModule {}
