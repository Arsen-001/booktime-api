import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE, type RequestWithContext } from './context.js';
import { SESSION_RESOLVER, type SessionResolver } from './resolvers.js';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Собирает req.ctx: id запроса (заголовок X-Request-Id или новый), IP, устройство, сессия из httpOnly cookie */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(@Inject(SESSION_RESOLVER) private readonly sessions: SessionResolver) {}

  async use(req: RequestWithContext, res: Response, next: NextFunction): Promise<void> {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = sid ? await this.sessions.resolve(sid) : null;
    req.ctx = {
      requestId,
      ip: req.ip ?? '',
      device: (req.header('user-agent') ?? '').slice(0, 200),
      session,
      member: null,
    };
    next();
  }
}
