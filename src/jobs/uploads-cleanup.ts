import type { FileStorage } from '../adapters/storage/storage.js';
import { logger } from '../common/logging/logger.js';
import { thumbKeyOf } from '../modules/uploads/image.js';
import { collectReferencedKeys, type RawDb } from '../modules/uploads/references.js';

/**
 * Уборка неиспользуемых загрузок (04.10.2026, «Файлы и фото»; воркер, каждую ночь 03:40 по Еревану).
 * Фото загружается до сохранения формы: закрыли форму, заменили фото, удалили карточку или документ — файл остаётся
 * без ссылок. Уборка удаляет строки uploads (и файлы: основной + превью, документы клиентов — из закрытого хранилища),
 * которые:
 * - старше 7 дней (свежие не трогаем никогда: форма может быть ещё открыта, отмена удаления, повторная загрузка
 *   того же файла обновляет created_at — UploadsService.touch);
 * - ни на что не ссылаются: ключ не встречается ни в одной text/JSON-колонке базы (references.ts — все таблицы, кроме
 *   журналов изменений), включая client_files.storage_key.
 * Безопасность: без UPLOADS_CLEANUP=1 — только отчёт в лог (пробный режим); ошибка поиска ссылок — ничего не удаляем;
 * не больше `limit` строк за ночь.
 */
export const CLEANUP_MIN_AGE_DAYS = 7;
const DAY = 86_400_000;

export interface UploadsCleanupDb extends RawDb {
  upload: {
    findMany(args: {
      where: { createdAt: { lt: Date } };
      select: { id: true; key: true; bytes: true; createdAt: true };
      orderBy: { createdAt: 'asc' };
      take: number;
    }): Promise<{ id: string; key: string; bytes: number; createdAt: Date }[]>;
    deleteMany(args: { where: { id: string; createdAt: { lt: Date } } }): Promise<{ count: number }>;
  };
}

export interface UploadsCleanupResult {
  apply: boolean;
  candidates: number;
  referenced: number;
  unreferenced: number;
  deleted: number;
  bytes: number;
  failed: number;
  columnsScanned: number;
  /** Первые ключи для лога (пробный режим — что удалилось бы) */
  sample: string[];
}

export async function uploadsCleanup(
  db: UploadsCleanupDb,
  storages: { images: FileStorage; documents: FileStorage },
  opts: { apply: boolean; now?: number; limit?: number },
): Promise<UploadsCleanupResult> {
  const now = opts.now ?? Date.now();
  // Не моложе 7 дней — даже если вызвали с другим now в будущем, порог считается от него же
  const cutoff = new Date(now - CLEANUP_MIN_AGE_DAYS * DAY);
  const res: UploadsCleanupResult = { apply: opts.apply, candidates: 0, referenced: 0, unreferenced: 0, deleted: 0, bytes: 0, failed: 0, columnsScanned: 0, sample: [] };
  const candidates = await db.upload.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, key: true, bytes: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 5000,
  });
  res.candidates = candidates.length;
  if (!candidates.length) return res;

  // Ошибка здесь пробрасывается — без полного списка ссылок не удаляем ничего
  const refs = await collectReferencedKeys(db);
  res.columnsScanned = refs.columnsScanned;
  const unreferenced = candidates.filter((c) => c.createdAt < cutoff && !refs.keys.has(c.key));
  res.referenced = candidates.length - unreferenced.length;
  res.unreferenced = unreferenced.length;
  res.bytes = unreferenced.reduce((s, c) => s + c.bytes, 0);
  res.sample = unreferenced.slice(0, 20).map((c) => c.key);
  if (!opts.apply) return res;

  for (const c of unreferenced) {
    const isDoc = c.key.startsWith('client-files/');
    if (!isDoc && !c.key.startsWith('uploads/')) continue;
    try {
      // Сначала строка (с повторной проверкой created_at: её могли «освежить» повторной загрузкой, пока шла уборка),
      // потом файлы — так файл живой строки не пропадёт никогда; сбой удаления файла оставит лишь файл без строки
      const { count } = await db.upload.deleteMany({ where: { id: c.id, createdAt: { lt: cutoff } } });
      if (!count) continue;
      if (isDoc) {
        await storages.documents.delete(c.key);
      } else {
        await storages.images.delete(c.key);
        await storages.images.delete(thumbKeyOf(c.key));
      }
      res.deleted++;
    } catch (err) {
      res.failed++;
      logger.warn({ key: c.key, err: (err as Error).message }, 'uploads.cleanup: delete failed');
    }
  }
  return res;
}
