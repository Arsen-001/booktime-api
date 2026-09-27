var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { from, switchMap } from 'rxjs';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
/** Что можно в заморозке (06 §3.4): оплатить, монеты, настройки/реквизиты, отметить «пришёл/не пришёл» */
const ALLOWED = [/^\/billing(\/|$)/, /^\/coins(\/|$)/, /^\/settings(\/|$)/, /^\/legal(\/|$)/, /^\/help-requests(\/|$)/, /^\/bookings\/[^/]+\/status$/];
const BIZ_PATH = /^\/v1\/biz\/([^/]+)(\/[^?]*)?/;
/**
 * В-02: «3 дня отсрочки → только чтение». Кабинет замороженного бизнеса открывается, но любая запись, кроме
 * списка выше, отвечает 423 `frozen` — экран показывает «Оплатите подписку». Черновик (`unpaid`) не ограничен:
 * самостоятельно зарегистрированный настраивает всё бесплатно.
 */
let FrozenInterceptor = class FrozenInterceptor {
    constructor(prisma) {
        this.prisma = prisma;
    }
    intercept(context, next) {
        const req = context.switchToHttp().getRequest();
        if (!req || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
            return next.handle();
        const m = BIZ_PATH.exec(req.path ?? req.url ?? '');
        if (!m)
            return next.handle();
        const rest = m[2] ?? '/';
        if (ALLOWED.some((re) => re.test(rest)))
            return next.handle();
        const businessId = m[1];
        return from(this.prisma.subscription.findUnique({ where: { businessId }, select: { status: true } })).pipe(switchMap((sub) => {
            if (sub && (sub.status === 'frozen' || sub.status === 'left'))
                throw new ApiError('frozen', 'Subscription is frozen: read-only until paid');
            return next.handle();
        }));
    }
};
FrozenInterceptor = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], FrozenInterceptor);
export { FrozenInterceptor };
//# sourceMappingURL=frozen.interceptor.js.map