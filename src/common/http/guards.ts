import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiCookieAuth } from '@nestjs/swagger';
import { ApiError } from '../errors/api-error.js';
import type { Permission } from '../permissions/permissions.js';
import type { RequestContext, RequestWithContext } from './context.js';
import { MEMBERSHIP_RESOLVER, type MembershipResolver } from './resolvers.js';

/** Контекст запроса в обработчике: handler(@Ctx() ctx: RequestContext) */
export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): RequestContext => {
  return host.switchToHttp().getRequest<RequestWithContext>().ctx;
});

/** Нужна сессия (любой вошедший) */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(host: ExecutionContext): boolean {
    const { ctx } = host.switchToHttp().getRequest<RequestWithContext>();
    if (!ctx?.session) throw new ApiError('unauthorized', 'Session required');
    return true;
  }
}

const REQUIRED = 'bt:required-permissions';

/**
 * Кабинет бизнеса: `businessId` из пути сверяется с членством вошедшего (арендатор, PLAN.md §5), затем права.
 * Чужой бизнес и «нет права» отвечают одинаково — 403 forbidden, без подсказки, существует ли бизнес.
 */
@Injectable()
export class BizGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_RESOLVER) private readonly memberships: MembershipResolver,
  ) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    const req = host.switchToHttp().getRequest<RequestWithContext>();
    const session = req.ctx?.session;
    if (!session) throw new ApiError('unauthorized', 'Session required');
    const businessId = req.params['businessId'];
    if (typeof businessId !== 'string' || !businessId) throw new ApiError('forbidden', 'Business is not accessible');
    const member = await this.memberships.resolve(session, businessId);
    if (!member) throw new ApiError('forbidden', 'Business is not accessible');
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED, [host.getHandler(), host.getClass()]) ?? [];
    const missing = required.filter((p) => !member.permissions.has(p));
    if (missing.length) throw new ApiError('forbidden', `Missing permission: ${missing.join(', ')}`);
    req.ctx.member = member;
    return true;
  }
}

/** Маршрут кабинета: @Biz('journal.edit') над обработчиком пути /v1/biz/:businessId/… */
export function Biz(...permissions: Permission[]) {
  return applyDecorators(SetMetadata(REQUIRED, permissions), UseGuards(BizGuard), ApiCookieAuth());
}

/** Маршрут для любого вошедшего: @Authed() */
export function Authed() {
  return applyDecorators(UseGuards(SessionGuard), ApiCookieAuth());
}

/** Арендатор в выборках: where: { ...tenant(ctx) } — business_id обязателен (PLAN.md §5) */
export function tenant(ctx: RequestContext): { businessId: string } {
  if (!ctx.member) throw new ApiError('forbidden', 'Business context required');
  return { businessId: ctx.member.businessId };
}

/** Наша панель: сессия команды платформы (Р11, своя cookie) */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(host: ExecutionContext): boolean {
    const { ctx } = host.switchToHttp().getRequest<RequestWithContext>();
    if (!ctx?.session?.platform) throw new ApiError('unauthorized', 'Platform session required');
    return true;
  }
}

/** Маршрут нашей панели /v1/platform/…: @Platform() */
export function Platform() {
  return applyDecorators(UseGuards(PlatformGuard), ApiCookieAuth());
}
