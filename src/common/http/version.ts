import { ApiError } from '../errors/api-error.js';
import type { RequestWithContext } from './context.js';

/**
 * Оптимистичная блокировка (docs/backend/02-api.md §0, F-01-033 «побеждает первое»): ответы несут `version`,
 * правка шлёт If-Match: <version>. Между чтением и записью кто-то уже сохранил — 409 conflict.
 */
export function ifMatch(req: RequestWithContext): number | undefined {
  const raw = req.header('if-match')?.replace(/^W\//, '').replace(/"/g, '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError('validation', 'If-Match must be a version number');
  return n;
}

/**
 * Атомарная правка с проверкой версии: updateMany по (id, version) и version+1 в одном запросе. 0 строк — либо записи
 * нет, либо её уже поменяли: различаем вторым чтением.
 */
export async function updateVersioned(
  delegate: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  },
  where: Record<string, unknown> & { id: string },
  expectedVersion: number | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await delegate.updateMany({
    where: expectedVersion === undefined ? where : { ...where, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (res.count === 1) return;
  const exists = await delegate.count({ where });
  if (!exists) throw new ApiError('not_found', 'Not found');
  throw new ApiError('conflict', 'Changed by someone else');
}
