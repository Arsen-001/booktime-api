import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';

function todayLocal(): string {
  return dayjs().format('YYYY-MM-DD');
}

const DEFAULT_CONFIG = { id: 'singleton', places: 6, scope: 'city', pricePerDay: 2000, lastPlacesCount: 2, lastPlacesMarkup: 50, queueMarkup: 30, daysAhead: 14 };

function configView(row: { places: number; scope: string; pricePerDay: number; lastPlacesCount: number; lastPlacesMarkup: number; queueMarkup: number; daysAhead: number }) {
  return { places: row.places as 5 | 6 | 10, scope: row.scope as 'district' | 'city', pricePerDay: row.pricePerDay, lastPlacesCount: row.lastPlacesCount, lastPlacesMarkup: row.lastPlacesMarkup, queueMarkup: row.queueMarkup, daysAhead: row.daysAhead };
}

/** Цена места сторис: последние lastPlacesCount мест дороже на lastPlacesMarkup % (rules.ts фронта) */
function storyPriceForTaken(config: ReturnType<typeof configView>, takenBefore: number): number {
  const onLastPlaces = takenBefore >= Math.max(0, config.places - config.lastPlacesCount);
  return onLastPlaces ? Math.round(config.pricePerDay * (1 + config.lastPlacesMarkup / 100)) : config.pricePerDay;
}

function storyQueuePrice(config: ReturnType<typeof configView>): number {
  return Math.round(config.pricePerDay * (1 + config.queueMarkup / 100));
}

/**
 * Места сторис (F-00-159…162, docs/backend/02 §19): настройки и доска панели. Покупка кабинетом ещё не построена
 * во фронте (07-mock-only P9, K18) — `bookings` на доске сейчас пуст на честной новой базе, это не баг.
 */
@Injectable()
export class StoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig() {
    const row = await this.prisma.storyConfig.upsert({ where: { id: 'singleton' }, update: {}, create: DEFAULT_CONFIG });
    return configView(row);
  }

  async saveConfig(input: ReturnType<typeof configView>) {
    if (input.pricePerDay < 0 || input.lastPlacesCount < 0 || input.lastPlacesCount > input.places) throw new ApiError('validation', 'lastPlacesCount out of range', { lastPlacesCount: 'range' });
    const row = await this.prisma.storyConfig.upsert({ where: { id: 'singleton' }, update: input, create: { id: 'singleton', ...input } });
    return configView(row);
  }

  private async placesInfo(config: ReturnType<typeof configView>, date: string, district?: string) {
    const rows = await this.prisma.storyBooking.findMany({ where: { date, status: 'active', district: config.scope === 'city' ? undefined : (district ?? undefined) } });
    const taken = rows.filter((b) => b.mode === 'place').length;
    return { date, district, total: config.places, taken, queued: rows.length - taken, price: storyPriceForTaken(config, taken), queuePrice: storyQueuePrice(config), rows };
  }

  async getBoard(days = 10, district?: string) {
    const config = await this.getConfig();
    const bizIds = new Set<string>();
    const dayInfos = await Promise.all(
      Array.from({ length: days }, (_, i) => dayjs().add(i, 'day').format('YYYY-MM-DD')).map((date) => this.placesInfo(config, date, district)),
    );
    dayInfos.forEach((d) => d.rows.forEach((r) => bizIds.add(r.businessId)));
    const names = new Map((await this.prisma.business.findMany({ where: { id: { in: [...bizIds] } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return {
      config,
      days: dayInfos.map(({ rows, ...info }) => {
        let queuePosition = 0;
        return {
          ...info,
          bookings: rows.map((b) => ({
            id: b.id,
            businessId: b.businessId,
            date: b.date,
            district: b.district ?? undefined,
            mode: b.mode as 'place' | 'queue',
            price: b.price,
            status: b.status as 'active' | 'cancelled' | 'rejected',
            source: b.source as 'template' | 'photo',
            moderationItemId: b.moderationItemId ?? undefined,
            createdAt: b.createdAt.toISOString(),
            views: b.views,
            clicks: b.clicks,
            bookingsFromStory: b.bookingsFromStory,
            businessName: names.get(b.businessId) ?? '',
            shown: b.mode === 'place',
            queuePosition: b.mode === 'queue' ? (queuePosition += 1) : undefined,
          })),
        };
      }),
    };
  }

  /** Для кабинета: сколько мест на дату и ближайшие дни со свободными местами (сейчас без вызывающего экрана) */
  async getPlaces(date: string, district?: string) {
    const config = await this.getConfig();
    const { rows: _rows, ...info } = await this.placesInfo(config, date, district);
    const available = info.taken < config.places;
    const alternatives: (typeof info)[] = [];
    if (!available) {
      for (let i = 1; i <= 5 && alternatives.length < 3; i++) {
        const { rows: _r, ...next } = await this.placesInfo(config, dayjs(date).add(i, 'day').format('YYYY-MM-DD'), district);
        if (next.taken < next.total) alternatives.push(next);
      }
    }
    return { available, info, alternatives };
  }
}
