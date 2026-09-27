import { AsyncLocalStorage } from 'node:async_hooks';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { ulid } from 'ulid';
import { ApiError as ServerApiError, ERROR_STATUS, type ErrorCode } from '../../../common/errors/api-error.js';
import type { CoreData } from './core-types.js';
import type { LoyaltyState } from './state.js';

/**
 * Подмена браузерных примитивов для перенесённого расчётного слоя лояльности (port/logic.ts — копия
 * booking-platform/src/api/loyalty.ts, см. scripts/sync-loyalty-port.mjs). Фасад фронта работает со «срезом»
 * (readArea/mutateArea) и «ядром» (readCore) моковой базы; здесь они указывают на состояние одного запроса:
 * срез собран из таблиц лояльности бизнеса (port/store.ts), ядро — из таблиц бизнеса/клиентов/записей
 * (port/core-loader.ts). Запрос идёт в AsyncLocalStorage, поэтому код фасада не меняется ни строкой.
 */

dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };

const YEREVAN_TZ = 'Asia/Yerevan';

/** Ядро спросили про записи, а их не загружали — запрос перезапускается с записями (port/runner.ts) */
export class NeedBookings extends Error {
  constructor() {
    super('loyalty port: bookings were not preloaded');
  }
}

export interface PortContext {
  state: LoyaltyState;
  core: CoreData;
}

const als = new AsyncLocalStorage<PortContext>();

export function runInPort<T>(ctx: PortContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

function current(): PortContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('loyalty port: called outside runInPort');
  return ctx;
}

/** Как request() фронта: выполнить внутри текущего запроса; ошибки — промисом */
export function request<T>(fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(fn);
}

export function readArea(_area: 'loyalty'): LoyaltyState {
  return current().state;
}

/** Как mutateArea фронта: правка копии; исключение в рецепте не оставляет полуправки */
export function mutateArea(_area: 'loyalty', recipe: (draft: LoyaltyState) => void | LoyaltyState): LoyaltyState {
  const ctx = current();
  const draft = structuredClone(ctx.state);
  const returned = recipe(draft);
  ctx.state = returned ?? draft;
  return ctx.state;
}

export function readCore(): CoreData {
  return current().core;
}

/** Коды ошибок мока — те же коды сервера (common/errors/api-error.ts) */
export class ApiError extends ServerApiError {
  constructor(code: string, message?: string) {
    super(code as ErrorCode, message ?? code);
    // код мока, которого нет в общем списке, — всё равно ошибка клиента, не 500
    if (!(code in ERROR_STATUS)) (this as { status: number }).status = 422;
  }
}

/** id как во фронте (`<префикс>_…`), но ULID: сортируется по времени, ≤ 32 символов при префиксе ≤ 5 */
export function newId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function toISODate(d: dayjs.Dayjs | Date | string): string {
  return dayjs(d).format('YYYY-MM-DD');
}

export function toISODateTime(d: dayjs.Dayjs | Date | string): string {
  return dayjs(d).format('YYYY-MM-DDTHH:mm');
}

/** «Сейчас» по стенным часам Еревана, как nowYerevan() фронта (сервер работает в UTC) */
export function nowYerevan(): dayjs.Dayjs {
  return dayjs(dayjs().tz(YEREVAN_TZ).format('YYYY-MM-DDTHH:mm:ss'), 'YYYY-MM-DDTHH:mm:ss');
}

export function nowDateTime(): string {
  return toISODateTime(nowYerevan());
}

export function today(): string {
  return toISODate(nowYerevan());
}

/** `new Date()` фронта: Date, у которого локальные поля (getDay/getHours) — стенные часы Еревана */
export function portNowDate(): Date {
  return nowYerevan().toDate();
}
