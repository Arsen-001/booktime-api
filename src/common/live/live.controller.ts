import { Controller, Inject, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { interval, map, merge, type Observable } from 'rxjs';
import { ApiError } from '../errors/api-error.js';
import type { RequestContext } from '../http/context.js';
import { Authed, Ctx } from '../http/guards.js';
import { LiveService } from './live.service.js';

/**
 * Можно ли вошедшему слушать канал. Этап 1 пускает только в свой `me`; бизнес-каналы подключает этап 3 (членство)
 * через LIVE_ACCESS — та же «розетка», что и у guards.
 */
export interface LiveAccess {
  canSubscribe(ctx: RequestContext, channel: string): Promise<boolean>;
}
export const LIVE_ACCESS = Symbol('LIVE_ACCESS');
export const ownChannelsOnly: LiveAccess = { canSubscribe: async () => false };

const CHANNEL_RE = /^(biz:[\w-]+:day:\d{4}-\d{2}-\d{2}|staff:[\w-]+|me)$/;
const MAX_CHANNELS = 20;

@ApiTags('system')
@Controller('v1/live')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    @Inject(LIVE_ACCESS) private readonly access: LiveAccess,
  ) {}

  /** SSE: /v1/live?channels=me,biz:biz_1:day:2026-09-27 — события перечитывания; комментарий-пульс каждые 25 с */
  @Sse()
  @Authed()
  @ApiQuery({ name: 'channels', description: 'Через запятую: me, staff:{id}, biz:{id}:day:{YYYY-MM-DD}' })
  async subscribe(@Query('channels') raw: string | undefined, @Ctx() ctx: RequestContext): Promise<Observable<MessageEvent>> {
    const requested = [...new Set((raw ?? 'me').split(',').map((s) => s.trim()).filter(Boolean))];
    if (requested.length > MAX_CHANNELS) throw new ApiError('validation', `At most ${MAX_CHANNELS} channels`);
    const channels: string[] = [];
    for (const ch of requested) {
      if (!CHANNEL_RE.test(ch)) throw new ApiError('validation', `Unknown channel: ${ch}`);
      if (ch === 'me') channels.push(`user:${ctx.session!.userId}`);
      else if (await this.access.canSubscribe(ctx, ch)) channels.push(ch);
      else throw new ApiError('forbidden', `Channel is not accessible: ${ch}`);
    }
    const events = this.live
      .stream(channels)
      .pipe(map(({ channel, event }) => ({ type: event.type, data: { channel: channel.startsWith('user:') ? 'me' : channel, ...event.data } })));
    const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: {} })));
    return merge(events, heartbeat);
  }
}
