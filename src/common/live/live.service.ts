import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Observable } from 'rxjs';
import { createRedis } from '../redis.js';
import { REDIS } from '../tokens.js';

/**
 * Живые изменения (PLAN.md Р9, §5): SSE /v1/live. Сервис публикует событие в канал через Redis pub/sub — его получат
 * все процессы API (и воркер может публиковать). Экран по событию перечитывает свои запросы.
 * Каналы: `biz:{businessId}:day:{YYYY-MM-DD}`, `staff:{staffId}`, `user:{userId}` (подписка `me`).
 */
export type LiveEventType = 'booking.changed' | 'schedule.changed' | 'mark.changed' | 'slots.changed' | 'inbox.new';

export interface LiveEvent {
  type: LiveEventType;
  /** Что перечитать: id сущностей, дата и т.п. — без персональных данных (их экран возьмёт запросом с правами) */
  data?: Record<string, unknown>;
}

const PREFIX = 'live:';

@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly sub = createRedis('live-sub');
  private readonly listeners = new Map<string, Set<(event: LiveEvent) => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.sub.on('message', (channel: string, message: string) => {
      const set = this.listeners.get(channel.slice(PREFIX.length));
      if (!set) return;
      const event = JSON.parse(message) as LiveEvent;
      for (const fn of set) fn(event);
    });
  }

  async publish(channel: string, event: LiveEvent): Promise<void> {
    await this.redis.publish(PREFIX + channel, JSON.stringify(event));
  }

  /** Поток событий по списку каналов; отписка — при отписке от Observable (закрыли вкладку) */
  stream(channels: string[]): Observable<{ channel: string; event: LiveEvent }> {
    return new Observable((subscriber) => {
      const fns = channels.map((channel) => {
        const fn = (event: LiveEvent) => subscriber.next({ channel, event });
        let set = this.listeners.get(channel);
        if (!set) {
          set = new Set();
          this.listeners.set(channel, set);
          void this.sub.subscribe(PREFIX + channel);
        }
        set.add(fn);
        return [channel, fn] as const;
      });
      return () => {
        for (const [channel, fn] of fns) {
          const set = this.listeners.get(channel);
          set?.delete(fn);
          if (set && set.size === 0) {
            this.listeners.delete(channel);
            void this.sub.unsubscribe(PREFIX + channel);
          }
        }
      };
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub.quit();
  }
}
