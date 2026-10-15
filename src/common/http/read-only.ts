import { SetMetadata } from '@nestjs/common';
import type { RequestWithContext } from './context.js';

export const READ_ONLY_KEY = 'bt:readOnly';

/** Условие для маршрута с разными операциями в пути (`…/loyalty/x/{op}`): true — этот вызов только читает */
export type ReadOnlyWhen = (req: RequestWithContext) => boolean;

/**
 * POST-маршрут, который только читает (поиск, таблица, проверка, предпросмотр, выгрузка): тело запроса длинное или
 * структурное, поэтому не GET. Замороженный бизнес (В-02, 423 `frozen`) такие запросы выполняет — FrozenInterceptor
 * пропускает их, как GET. Без аргумента — весь маршрут; с функцией — только вызовы, для которых она вернула true.
 * Ставить только на обработчики, которые ничего не меняют в данных бизнеса (след в журнале выгрузок допустим).
 */
export function ReadOnly(when?: ReadOnlyWhen) {
  return SetMetadata(READ_ONLY_KEY, when ?? true);
}

/** Значение метки ReadOnly → пропускать ли этот запрос (для FrozenInterceptor) */
export function isReadOnlyRequest(meta: unknown, req: RequestWithContext): boolean {
  if (meta === true) return true;
  if (typeof meta === 'function') return Boolean((meta as ReadOnlyWhen)(req));
  return false;
}
