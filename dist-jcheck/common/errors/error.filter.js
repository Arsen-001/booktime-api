var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { logger } from '../logging/logger.js';
import { ApiError } from './api-error.js';
const STATUS_TO_CODE = {
    [HttpStatus.NOT_FOUND]: 'not_found',
    [HttpStatus.UNAUTHORIZED]: 'unauthorized',
    [HttpStatus.FORBIDDEN]: 'forbidden',
    [HttpStatus.CONFLICT]: 'conflict',
    [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
    [HttpStatus.BAD_REQUEST]: 'validation',
};
/** Любая ошибка наружу — только { code, message } (docs/backend/02-api.md §0). Внутренности не утекают. */
let ErrorFilter = class ErrorFilter {
    catch(exception, host) {
        const res = host.switchToHttp().getResponse();
        let status;
        let body;
        if (exception instanceof ApiError) {
            status = exception.status;
            body = { code: exception.code, message: exception.message, ...(exception.fields ? { fields: exception.fields } : {}) };
            if (exception.retryAfter !== undefined) {
                body.retryAfter = exception.retryAfter;
                res.setHeader('Retry-After', String(exception.retryAfter));
            }
        }
        else if (exception instanceof HttpException) {
            status = exception.getStatus();
            body = { code: STATUS_TO_CODE[status] ?? 'internal', message: exception.message };
        }
        else {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
            body = { code: 'internal', message: 'Internal error' };
            logger.error({ err: exception }, 'unhandled error');
        }
        res.status(status).json(body);
    }
};
ErrorFilter = __decorate([
    Catch()
], ErrorFilter);
export { ErrorFilter };
//# sourceMappingURL=error.filter.js.map