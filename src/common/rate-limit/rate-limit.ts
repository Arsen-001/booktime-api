import { applyDecorators, CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { ApiError } from '../errors/api-error.js';
import type { RequestWithContext } from '../http/context.js';
import { REDIS } from '../tokens.js';

/** Лимиты в Redis (PLAN.md §5): вход по коду, отправка кода, публичные страницы. Окно фиксированное. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Засчитать попытку; allowed=false — лимит исчерпан, retryAfter — секунд до нового окна */
  async hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const k = `rl:${key}`;
    const [[, count], [, ttl]] = (await this.redis.multi().incr(k).ttl(k).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await this.redis.expire(k, windowSec);
    return { allowed: count <= limit, retryAfter: ttl > 0 ? ttl : windowSec };
  }
}

interface RateRule {
  bucket: string;
  limit: number;
  windowSec: number;
  /** Чем различать: IP (без входа) или сессия */
  by: 'ip' | 'session';
}
const RULE = 'bt:rate-limit';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<RateRule>(RULE, host.getHandler());
    if (!rule) return true;
    const req = host.switchToHttp().getRequest<RequestWithContext>();
    const who = rule.by === 'session' ? (req.ctx.session?.sessionId ?? req.ctx.ip) : req.ctx.ip;
    const res = await this.limits.hit(`${rule.bucket}:${who}`, rule.limit, rule.windowSec);
    if (!res.allowed) {
      host.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(res.retryAfter));
      throw new ApiError('rate_limited', `Too many requests, retry in ${res.retryAfter}s`);
    }
    return true;
  }
}

/**
 * @RateLimit({ bucket: 'auth-code', limit: 5, windowSec: 600, by: 'ip' }). Одно имя корзины — одни limit/windowSec:
 * счётчик общий, и чужое окно (час вместо минуты) иначе запирало просмотры записи по ссылке после одной отмены.
 */
export function RateLimit(rule: RateRule) {
  return applyDecorators(SetMetadata(RULE, rule), UseGuards(RateLimitGuard));
}
