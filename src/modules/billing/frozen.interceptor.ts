import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, switchMap, type Observable } from 'rxjs';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestWithContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';

/** Что можно в заморозке (06 §3.4): оплатить, монеты, настройки/реквизиты, отметить «пришёл/не пришёл» */
const ALLOWED = [/^\/billing(\/|$)/, /^\/coins(\/|$)/, /^\/settings(\/|$)/, /^\/legal(\/|$)/, /^\/help-requests(\/|$)/, /^\/bookings\/[^/]+\/status$/];
const BIZ_PATH = /^\/v1\/biz\/([^/]+)(\/[^?]*)?/;

/**
 * В-02: «3 дня отсрочки → только чтение». Кабинет замороженного бизнеса открывается, но любая запись, кроме
 * списка выше, отвечает 423 `frozen` — экран показывает «Оплатите подписку». Черновик (`unpaid`) не ограничен:
 * самостоятельно зарегистрированный настраивает всё бесплатно.
 */
@Injectable()
export class FrozenInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    if (!req || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next.handle();
    const m = BIZ_PATH.exec(req.path ?? req.url ?? '');
    if (!m) return next.handle();
    const rest = m[2] ?? '/';
    if (ALLOWED.some((re) => re.test(rest))) return next.handle();
    const businessId = m[1]!;
    return from(this.prisma.subscription.findUnique({ where: { businessId }, select: { status: true } })).pipe(
      switchMap((sub) => {
        if (sub && (sub.status === 'frozen' || sub.status === 'left')) throw new ApiError('frozen', 'Subscription is frozen: read-only until paid');
        return next.handle();
      }),
    );
  }
}
