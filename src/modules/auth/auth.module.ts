import { Module } from '@nestjs/common';
import { AccountController } from '../account/account.controller.js';
import { AccountService } from '../account/account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { env } from '../../common/config/env.js';
import { REDIS } from '../../common/tokens.js';
import { GoogleIdTokenVerifier } from './google-id-token.js';
import { GOOGLE_PENDING, RedisGooglePending } from './google-pending.js';
import type { Redis } from 'ioredis';
import { OtpService } from './otp.service.js';

/** Этап 2: вход (код, пароль администратора, второй шаг, команда платформы), сессии, аккаунт */
@Module({
  controllers: [AuthController, AccountController],
  providers: [
    OtpService,
    AuthService,
    AccountService,
    // «Войти через Google» (03.10.2026): проверка ID token по ключам Google; ожидание привязки — в Redis
    { provide: GoogleIdTokenVerifier, useFactory: () => new GoogleIdTokenVerifier({ clientIds: env.GOOGLE_CLIENT_ID }) },
    { provide: GOOGLE_PENDING, useFactory: (redis: Redis) => new RedisGooglePending(redis), inject: [REDIS] },
  ],
  exports: [OtpService, AuthService],
})
export class AuthModule {}
