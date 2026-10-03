import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import type { PrismaService } from '../common/prisma.service.js';

/**
 * Ежедневная выгрузка базы (03.10.2026): пока на Railway тариф Hobby, снимков дисков нет — воркер сам раз в сутки
 * пишет полную копию базы (структура + данные) в `<DB_BACKUP_DIR>/db-YYYY-MM-DD.sql.gz` и хранит последние
 * DB_BACKUP_KEEP файлов. Папка — вне STORAGE_DIR (файлы хранилища раздаются, копия базы — никогда). Диск — у сервиса api, отдельный от диска MySQL: защищает от неудачной миграции, ошибки
 * или случайного удаления данных, но не от потери всего проекта — для этого нужна копия вне Railway
 * (скачать: docs/DEPLOY.md, «Бэкапы»). Восстановление: `gunzip -c db-….sql.gz | mysql -u… -p… <база>`.
 * Без mysqldump (его нет в образе): чтение через Prisma порциями по первичному ключу, SQL-литералы — свои.
 */
const CHUNK = 2000;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Значение из $queryRaw → SQL-литерал MySQL */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'NULL';
    const ms = String(v.getUTCMilliseconds()).padStart(3, '0');
    return `'${v.getUTCFullYear()}-${two(v.getUTCMonth() + 1)}-${two(v.getUTCDate())} ${two(v.getUTCHours())}:${two(v.getUTCMinutes())}:${two(v.getUTCSeconds())}.${ms}'`;
  }
  if (v instanceof Uint8Array) return v.length ? `X'${Buffer.from(v).toString('hex')}'` : "''";
  const s = typeof v === 'string' ? v : typeof (v as { toFixed?: unknown }).toFixed === 'function' ? String(v) : JSON.stringify(v);
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z')}'`;
}

function quoteId(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Полная копия базы в поток (gzip снаружи). Возвращает число таблиц и строк. */
export async function dumpDatabase(prisma: PrismaService, write: (chunk: string) => Promise<void>): Promise<{ tables: number; rows: number }> {
  const tables = (await prisma.$queryRawUnsafe<Record<string, string>[]>('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\''))
    .map((r) => String(Object.values(r)[0]))
    .sort();
  await write(`-- BookTime: копия базы ${new Date().toISOString()}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\nSET time_zone = '+00:00';\n\n`);
  let rows = 0;
  for (const table of tables) {
    const t = quoteId(table);
    const create = await prisma.$queryRawUnsafe<Record<string, string>[]>(`SHOW CREATE TABLE ${t}`);
    await write(`DROP TABLE IF EXISTS ${t};\n${create[0]?.['Create Table'] ?? ''};\n`);
    const keys = await prisma.$queryRawUnsafe<{ Column_name: string }[]>(`SHOW KEYS FROM ${t} WHERE Key_name = 'PRIMARY'`);
    const order = keys.length ? ` ORDER BY ${keys.map((k) => quoteId(k.Column_name)).join(', ')}` : '';
    for (let offset = 0; ; offset += CHUNK) {
      const batch = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${t}${order} LIMIT ${CHUNK} OFFSET ${offset}`);
      if (!batch.length) break;
      const cols = Object.keys(batch[0] ?? {}).map(quoteId).join(', ');
      const values = batch.map((r) => `(${Object.values(r).map(sqlLiteral).join(', ')})`).join(',\n');
      await write(`INSERT INTO ${t} (${cols}) VALUES\n${values};\n`);
      rows += batch.length;
      if (batch.length < CHUNK) break;
    }
    await write('\n');
  }
  await write('SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n');
  return { tables: tables.length, rows };
}

/** Задача воркера: файл за сегодня (по UTC) + удаление старых сверх keep */
export async function dbBackup(prisma: PrismaService, backupDir: string, keep: number): Promise<{ file: string; tables: number; rows: number; bytes: number; removed: number }> {
  const dir = path.resolve(backupDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `db-${new Date().toISOString().slice(0, 10)}.sql.gz`;
  const tmp = path.join(dir, `.${name}.part`);
  const gzip = createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gzip.pipe(out);
  const write = async (chunk: string) => {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  };
  let stats: { tables: number; rows: number };
  try {
    stats = await dumpDatabase(prisma, write);
    gzip.end();
    await once(out, 'finish');
  } catch (e) {
    gzip.destroy();
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  const file = path.join(dir, name);
  await fs.promises.rename(tmp, file);
  const all = (await fs.promises.readdir(dir)).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(f)).sort();
  const old = all.slice(0, Math.max(0, all.length - keep));
  for (const f of old) await fs.promises.rm(path.join(dir, f), { force: true });
  const { size } = await fs.promises.stat(file);
  return { file: name, ...stats, bytes: size, removed: old.length };
}
