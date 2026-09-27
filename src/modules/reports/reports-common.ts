import dayjs from 'dayjs';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, isLocalDate, utcToLocalDate } from '../../common/time/time.js';

/**
 * Общее для отчётов (docs/backend/02 §16, PLAN §6 №16): бизнес может состоять из нескольких филиалов с РАЗНЫМ
 * поясом (Location.tz) — PLAN §4.1 требует считать «день» в поясе филиала, не общим поясом бизнеса (тот же
 * принцип, что этап 15 применил к сети). Вместо N запросов на филиал (как network-reports) берём одним
 * запросом широкий диапазон UTC, который заведомо покрывает [from, to] в ЛЮБОМ поясе (±26 ч запаса), и уже в
 * коде проверяем реальную локальную дату по tz КОНКРЕТНОГО филиала записи — дешевле на бизнесах с 1 филиалом
 * (подавляющее большинство сидовых), не хуже на редких мульти-tz.
 */

export interface ReportRange {
  from: string;
  to: string;
}

export function requireRange(input: { from?: string; to?: string }): ReportRange {
  const from = input.from;
  const to = input.to;
  if (!isLocalDate(from) || !isLocalDate(to)) throw new ApiError('validation', 'from/to must be YYYY-MM-DD', { from: 'bad_date', to: 'bad_date' });
  if (from > to) throw new ApiError('validation', 'from must be <= to', { from: 'range' });
  return { from, to };
}

/** Диапазон в UTC заведомо покрывающий [from,to] в любом поясе — фильтр по месту сузит его до реальной локальной даты */
export function wideUtcBounds(range: ReportRange): { from: Date; to: Date } {
  return { from: dayjs.utc(range.from).subtract(2, 'day').toDate(), to: dayjs.utc(range.to).add(3, 'day').toDate() };
}

/** Предыдущий период той же длины, вплотную примыкающий к началу текущего (F-12-017/023) */
export function priorRange(range: ReportRange): ReportRange {
  const days = dayjs(range.to).diff(dayjs(range.from), 'day') + 1;
  const to = dayjs(range.from).subtract(1, 'day');
  const from = to.subtract(days - 1, 'day');
  return { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') };
}

export interface MetricValue {
  value: number;
  deltaPct?: number;
  isNew?: boolean;
}

/** F-12-017: было 0, стало >0 → «новое», не процент; было 0 и осталось 0 → без deltaPct */
export function metricValue(current: number, previous: number): MetricValue {
  if (previous === 0) return current > 0 ? { value: current, isNew: true } : { value: current };
  return { value: current, deltaPct: Math.round(((current - previous) / previous) * 1000) / 10 };
}

export interface LocationTz {
  id: string;
  tz: string;
}

export async function locationsOf(prisma: PrismaService, businessId: string, locationIds?: string[]): Promise<LocationTz[]> {
  const rows = await prisma.location.findMany({
    where: { businessId, deletedAt: null, ...(locationIds?.length ? { id: { in: locationIds } } : {}) },
    select: { id: true, tz: true },
  });
  if (locationIds?.length && !rows.length) throw new ApiError('validation', 'Unknown locationIds');
  return rows;
}

export function tzMapOf(locations: LocationTz[]): Map<string, string> {
  return new Map(locations.map((l) => [l.id, l.tz] as const));
}

/** Локальная дата записи в поясе ЕЁ филиала; неизвестный филиал — запасной пояс (PLAN §4.1 умолчание) */
export function localDateAt(at: Date, locationId: string, tzMap: Map<string, string>): string {
  return utcToLocalDate(at, tzMap.get(locationId) ?? DEFAULT_TZ);
}

export function inRange(date: string, range: ReportRange): boolean {
  return date >= range.from && date <= range.to;
}
