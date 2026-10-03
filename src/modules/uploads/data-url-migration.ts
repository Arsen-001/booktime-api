import { createHash } from 'node:crypto';
import type { FileStorage } from '../../adapters/storage/storage.js';
import { newId } from '../../common/ids/ids.js';
import { photoModerationRefId } from '../platform/moderation.service.js';
import { processImage, uploadKeys } from './image.js';
import { IMMUTABLE_CACHE } from './uploads.service.js';

/**
 * Перенос старых фото из базы в хранилище (04.10.2026, «Файлы и фото»): ищет data:image/…;base64,… во ВСЕХ
 * текстовых и JSON-колонках (поля фото, JSON настроек, сторис, модерация…), кладёт картинку в хранилище тем же
 * путём, что загрузка (перекодирование, превью, строка uploads), и заменяет data: URL адресом файла.
 * Запуск — scripts/migrate-data-urls.ts (по умолчанию только отчёт, без записи).
 */

/** data: URL картинки внутри любой строки (поле целиком, JSON, текст) */
export const DATA_URL_RE = /data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}/g;

/** Таблицы, которые не трогаем: служебные, сами загрузки, документы клиентов (там не только картинки, скачиваются как файл) */
export const DEFAULT_SKIP = ['_prisma_migrations', 'uploads', 'client_files'];

/** Заменить все data: URL в тексте; replace — асинхронно, по одному на уникальную картинку */
export async function rewriteDataUrls(text: string, replace: (dataUrl: string) => Promise<string | null>): Promise<{ text: string; found: number; replaced: number }> {
  const matches = [...new Set(text.match(DATA_URL_RE) ?? [])];
  if (!matches.length) return { text, found: 0, replaced: 0 };
  let out = text;
  let replaced = 0;
  for (const m of matches) {
    const url = await replace(m);
    if (!url) continue;
    out = out.split(m).join(url);
    replaced++;
  }
  return { text: out, found: matches.length, replaced };
}

interface Db {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface MigrationOptions {
  db: Db;
  storage: FileStorage;
  /** Адрес файла по ключу (как UploadsService.urlOf) */
  urlOf: (key: string) => string;
  apply: boolean;
  skip?: string[];
  only?: string[];
  log?: (line: string) => void;
}

export interface MigrationReport {
  columns: { table: string; column: string; rows: number; dataUrls: number; replaced: number; bytesBefore: number }[];
  uniqueImages: number;
  failed: number;
  moderationRefsUpdated: number;
}

const q = (id: string) => '`' + id.replace(/`/g, '``') + '`';

export async function migrateDataUrls(o: MigrationOptions): Promise<MigrationReport> {
  const log = o.log ?? (() => {});
  const skip = new Set(o.skip ?? DEFAULT_SKIP);
  const cols = await o.db.$queryRawUnsafe<{ t: string; c: string; dt: string }[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('json','longtext','mediumtext','text','varchar') ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const pkRows = await o.db.$queryRawUnsafe<{ t: string; c: string }[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const pks = new Map<string, string[]>();
  for (const r of pkRows) pks.set(r.t, [...(pks.get(r.t) ?? []), r.c]);
  const colsOf = new Map<string, Set<string>>();
  for (const r of cols) colsOf.set(r.t, (colsOf.get(r.t) ?? new Set()).add(r.c));

  const report: MigrationReport = { columns: [], uniqueImages: 0, failed: 0, moderationRefsUpdated: 0 };
  /** sha256(data URL) → новый адрес (null — картинку не удалось разобрать) */
  const done = new Map<string, string | null>();
  const refMoves: [string, string][] = [];

  const convert = async (dataUrl: string, owner: string): Promise<string | null> => {
    const h = createHash('sha256').update(dataUrl).digest('hex');
    if (done.has(h)) return done.get(h)!;
    let url: string | null = null;
    try {
      const img = await processImage(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      const { key, thumbKey } = uploadKeys(owner, img);
      if (o.apply) {
        await o.storage.put(key, img.main, img.mime, { cacheControl: IMMUTABLE_CACHE });
        await o.storage.put(thumbKey, img.thumb, img.mime, { cacheControl: IMMUTABLE_CACHE });
        const isBiz = owner.startsWith('biz_');
        const isUser = owner.startsWith('au_');
        await o.db.$executeRawUnsafe(
          'INSERT IGNORE INTO `uploads` (id, business_id, user_id, `key`, mime, bytes, width, height, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
          newId('upload'),
          isBiz ? owner : null,
          isUser ? owner : null,
          key,
          img.mime,
          img.main.length + img.thumb.length,
          img.width,
          img.height,
          'migration',
        );
      }
      url = o.urlOf(key);
      refMoves.push([photoModerationRefId(dataUrl), photoModerationRefId(url)]);
      report.uniqueImages++;
    } catch (e) {
      report.failed++;
      log(`  ! не разобрать картинку (${dataUrl.length} симв.): ${(e as Error).message}`);
    }
    done.set(h, url);
    return url;
  };

  for (const { t, c, dt } of cols) {
    if (skip.has(t) || (o.only && !o.only.includes(t))) continue;
    const pk = pks.get(t);
    if (!pk?.length) continue;
    const isJson = dt === 'json';
    const textExpr = isJson ? `CAST(${q(c)} AS CHAR)` : q(c);
    const rows = await o.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${pk.map(q).join(', ')} FROM ${q(t)} WHERE ${textExpr} LIKE '%data:image/%'`,
    );
    if (!rows.length) continue;
    const tableCols = colsOf.get(t)!;
    const stat = { table: t, column: c, rows: 0, dataUrls: 0, replaced: 0, bytesBefore: 0 };
    for (const keyRow of rows) {
      const where = pk.map((k) => `${q(k)} = ?`).join(' AND ');
      const keyVals = pk.map((k) => keyRow[k]);
      const sel = await o.db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${textExpr} AS v${tableCols.has('business_id') ? ', `business_id` AS b' : ''}${tableCols.has('user_id') ? ', `user_id` AS u' : ''} FROM ${q(t)} WHERE ${where}`,
        ...keyVals,
      );
      const row = sel[0];
      if (!row || typeof row.v !== 'string') continue;
      const owner = (row.b as string | null | undefined) ?? (t === 'businesses' ? String(keyRow['id']) : null) ?? (row.u as string | null | undefined) ?? 'legacy';
      const before = row.v;
      const res = await rewriteDataUrls(before, (d) => convert(d, owner));
      stat.rows++;
      stat.dataUrls += res.found;
      stat.replaced += res.replaced;
      stat.bytesBefore += before.length;
      if (o.apply && res.replaced > 0) {
        const value = isJson ? `CAST(? AS JSON)` : '?';
        await o.db.$executeRawUnsafe(`UPDATE ${q(t)} SET ${q(c)} = ${value} WHERE ${where}`, res.text, ...keyVals);
      }
    }
    report.columns.push(stat);
    log(`${t}.${c}: строк ${stat.rows}, картинок ${stat.dataUrls}, заменено ${stat.replaced}, ${(stat.bytesBefore / 1024 / 1024).toFixed(1)} МБ текста`);
  }

  // Модерация находит фото по хешу адреса — после замены адреса переносим refId на новый хеш
  if (o.apply) {
    for (const [from, to] of refMoves) {
      report.moderationRefsUpdated += await o.db.$executeRawUnsafe('UPDATE `moderation_items` SET `ref_id` = ? WHERE `ref_id` = ?', to, from);
    }
  }
  return report;
}
