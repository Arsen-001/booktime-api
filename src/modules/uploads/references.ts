/**
 * Где в базе лежат строки (04.10.2026, «Файлы и фото»): все text/JSON-колонки всех таблиц из information_schema.
 * Общая часть переноса data: URL (data-url-migration.ts) и уборки неиспользуемых файлов (jobs/uploads-cleanup.ts):
 * адрес фото может оказаться в любом поле (поля фото, JSON настроек, сторис, тексты), поэтому ищем везде, а не по
 * списку «известных» колонок, который устареет с первой же новой таблицей.
 */

export interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface TextColumn {
  table: string;
  column: string;
  /** json | longtext | mediumtext | text | varchar */
  dataType: string;
}

export const q = (id: string) => '`' + id.replace(/`/g, '``') + '`';

/** Все текстовые и JSON-колонки текущей базы + первичные ключи таблиц */
export async function listTextColumns(db: RawDb): Promise<{ columns: TextColumn[]; pks: Map<string, string[]>; colsOf: Map<string, Set<string>> }> {
  const cols = await db.$queryRawUnsafe<{ t: string; c: string; dt: string }[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('json','longtext','mediumtext','text','varchar') ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const pkRows = await db.$queryRawUnsafe<{ t: string; c: string }[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const pks = new Map<string, string[]>();
  for (const r of pkRows) pks.set(r.t, [...(pks.get(r.t) ?? []), r.c]);
  const colsOf = new Map<string, Set<string>>();
  for (const r of cols) colsOf.set(r.t, (colsOf.get(r.t) ?? new Set()).add(r.c));
  return { columns: cols.map((r) => ({ table: r.t, column: r.c, dataType: r.dt })), pks, colsOf };
}

/**
 * Ключи хранилища внутри любого текста: фото `uploads/<владелец>/<hash>[_t].<jpg|webp>` (превью сводится к основному
 * ключу — одна строка uploads на пару) и документы клиентов `client-files/<бизнес>/<hash>.<ext>`.
 */
const KEY_RE = /\b(?:uploads\/[A-Za-z0-9_-]{1,40}\/[0-9a-f]{32}(?:_t)?\.(?:jpg|webp)|client-files\/[A-Za-z0-9_-]{1,40}\/[0-9a-f]{32}\.(?:pdf|jpg|png|gif|webp|docx|xlsx|doc|xls|txt))\b/g;

export function extractStorageKeys(text: string): string[] {
  return (text.match(KEY_RE) ?? []).map((k) => k.replace(/_t\.(jpg|webp)$/, '.$1'));
}

/**
 * Таблицы, где упоминание файла — не ссылка: сами загрузки, служебные, журналы изменений и доставок (там остаются
 * старые адреса заменённых фото — из-за них уборка никогда бы ничего не удаляла).
 */
export const REFERENCE_SKIP = [
  '_prisma_migrations',
  'uploads',
  'audit_events',
  'booking_history',
  'schedule_history',
  'settings_change_log',
  'price_rule_changes',
  'notify_log_entries',
  'notify_outbox',
  'login_events',
  'webhook_deliveries',
];

const PAGE = 1000;

/**
 * Все ключи хранилища, на которые ссылается база: ищет 'uploads/' и 'client-files/' во всех text/JSON-колонках
 * (кроме REFERENCE_SKIP), постранично. Любая ошибка — исключение (уборка тогда ничего не удаляет).
 */
export async function collectReferencedKeys(db: RawDb, opts: { skip?: string[] } = {}): Promise<{ keys: Set<string>; columnsScanned: number }> {
  const skip = new Set(opts.skip ?? REFERENCE_SKIP);
  const { columns, pks } = await listTextColumns(db);
  const keys = new Set<string>();
  let columnsScanned = 0;
  for (const { table, column, dataType } of columns) {
    if (skip.has(table)) continue;
    const pk = pks.get(table);
    const textExpr = dataType === 'json' ? `CAST(${q(column)} AS CHAR)` : q(column);
    const order = pk?.length ? ` ORDER BY ${pk.map(q).join(', ')}` : '';
    columnsScanned++;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await db.$queryRawUnsafe<{ v: unknown }[]>(
        `SELECT ${textExpr} AS v FROM ${q(table)} WHERE ${textExpr} LIKE '%uploads/%' OR ${textExpr} LIKE '%client-files/%'${order} LIMIT ${PAGE} OFFSET ${offset}`,
      );
      for (const r of rows) if (typeof r.v === 'string') for (const k of extractStorageKeys(r.v)) keys.add(k);
      if (rows.length < PAGE) break;
    }
  }
  return { keys, columnsScanned };
}
