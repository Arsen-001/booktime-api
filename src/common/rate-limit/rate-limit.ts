import { applyDecorators, CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
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

export interface RateRule {
  bucket: string;
  limit: number;
  windowSec: number;
  /** Чем различать: IP (без входа) или сессия */
  by: 'ip' | 'session';
}
const RULE = 'bt:rate-limit';

/** Заголовок, которым сервер сайта (SSR на Vercel) подтверждает, что запрос его (значение — SSR_SHARED_SECRET) */
export const SSR_HEADER = 'x-bt-ssr';

/** Запрос пришёл от SSR нашего сайта: секрет задан и совпал (сравнение за постоянное время) */
export function isOwnSsr(header: string | string[] | undefined, secret = env.SSR_SHARED_SECRET): boolean {
  if (!secret || typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Корзина и предел для запроса. SSR сайта (04.10.2026): все посетители сайта приходят к API с нескольких адресов
 * Vercel, и поисковый робот, листающий страницы салонов, иначе выбирал бы лимит IP за всех. С верным X-BT-SSR
 * публичные чтения (GET, лимит по IP) считаются в своей корзине `ssr:<bucket>` с пределом × SSR_RATE_MULTIPLIER.
 * Записи (код, запись, отмена) и лимиты по сессии — как у всех: SSR их не делает.
 */
export function effectiveRule(rule: RateRule, req: { method?: string; header(name: string): string | undefined }, secret = env.SSR_SHARED_SECRET, multiplier = env.SSR_RATE_MULTIPLIER): { bucket: string; limit: number } {
  if (rule.by === 'ip' && (req.method ?? 'GET').toUpperCase() === 'GET' && isOwnSsr(req.header(SSR_HEADER), secret)) {
    return { bucket: `ssr:${rule.bucket}`, limit: rule.limit * multiplier };
  }
  return { bucket: rule.bucket, limit: rule.limit };
}

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
    const { bucket, limit } = effectiveRule(rule, req);
    const res = await this.limits.hit(`${bucket}:${who}`, limit, rule.windowSec);
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
