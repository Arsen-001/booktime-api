import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { logger } from '../logging/logger.js';
import { ApiError, type ErrorBody, type ErrorCode } from './api-error.js';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
  [HttpStatus.BAD_REQUEST]: 'validation',
};

/** Любая ошибка наружу — только { code, message } (docs/backend/02-api.md §0). Внутренности не утекают. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status: number;
    let body: ErrorBody;
    if (exception instanceof ApiError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, ...(exception.fields ? { fields: exception.fields } : {}) };
      if (exception.retryAfter !== undefined) {
        body.retryAfter = exception.retryAfter;
        res.setHeader('Retry-After', String(exception.retryAfter));
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: STATUS_TO_CODE[status] ?? 'internal', message: exception.message };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { code: 'internal', message: 'Internal error' };
      logger.error({ err: exception }, 'unhandled error');
    }
    res.status(status).json(body);
  }
}
