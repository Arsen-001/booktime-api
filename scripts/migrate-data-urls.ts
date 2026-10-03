/**
 * Разовый перенос старых фото (data: URL в колонках базы) в хранилище — «Файлы и фото», 04.10.2026.
 *
 *   npx tsx scripts/migrate-data-urls.ts                 # ТОЛЬКО ОТЧЁТ: что и сколько нашлось, ничего не пишет
 *   npx tsx scripts/migrate-data-urls.ts --apply         # перенести: файлы в хранилище, строки uploads, замена адресов
 *   … --only=businesses,staff   … --skip=audit_events   (по умолчанию пропускаются _prisma_migrations, uploads, client_files)
 *
 * Документы клиентов (client_files, 04.10.2026) — отдельный шаг того же запуска: файл как есть (PDF, фото, Office,
 * текст; тип по сигнатуре) в ЗАКРЫТОЕ хранилище (S3 под private/ или диск PRIVATE_FILES_DIR), в строке — storage_key,
 * data_url очищается; скачивание — только через кабинет с правом clients.view. --skip=client_files — без этого шага,
 * --only=client_files — только он. Без --apply — тоже только отчёт.
 *
 * Переменные — как у сервера: DATABASE_URL, хранилище (UPLOADS_DIR или S3_*), и адрес для ссылок: S3_PUBLIC_URL
 * или PUBLIC_API_URL (обязателен для диска — ссылки должны вести на настоящий адрес API, например https://api.booktime.am).
 * Перед --apply — свежая копия базы (docs/DEPLOY.md «Бэкапы базы»). Повторный запуск безопасен: уже перенесённых
 * data: URL не остаётся, одинаковые картинки получают один файл. НЕ запускать без решения владельца.
 */
import 'reflect-metadata';
import { createPrivateUploadStorage, createUploadStorage, storageConfig } from '../src/adapters/storage/storage.js';
import { env } from '../src/common/config/env.js';
import { PrismaService } from '../src/common/prisma.service.js';
import { DEFAULT_SKIP, migrateClientFiles, migrateDataUrls } from '../src/modules/uploads/data-url-migration.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.split(',').filter(Boolean);
const apply = args.includes('--apply');

const cfg = storageConfig();
const base = cfg.driver === 's3' && cfg.publicUrl ? cfg.publicUrl : env.PUBLIC_API_URL?.replace(/\/+$/, '');
if (!base) {
  console.error('Нужен PUBLIC_API_URL (адрес API для ссылок /v1/files/…) или S3_PUBLIC_URL');
  process.exit(1);
}
const urlOf = (key: string) => (cfg.driver === 's3' && cfg.publicUrl ? `${base}/${key}` : `${base}/v1/files/${key}`);

const db = new PrismaService();
console.log(`${apply ? 'ПЕРЕНОС' : 'Отчёт (без записи; --apply — перенести)'} · хранилище: ${cfg.driver} · ссылки: ${urlOf('uploads/…')}`);
try {
  const only = flag('only');
  const skip = flag('skip') ?? [];
  const imagesOnly = only?.filter((t) => t !== 'client_files');
  if (!only || imagesOnly!.length) {
    const report = await migrateDataUrls({
      db,
      storage: createUploadStorage(cfg),
      urlOf,
      apply,
      skip: [...DEFAULT_SKIP, ...skip],
      only: imagesOnly,
      log: (l) => console.log(l),
    });
    const total = report.columns.reduce((s, c) => s + c.bytesBefore, 0);
    console.log(
      `Итого: колонок ${report.columns.length}, уникальных картинок ${report.uniqueImages}, не разобрать ${report.failed}, ` +
        `текста с картинками ${(total / 1024 / 1024).toFixed(1)} МБ${apply ? `, refId модерации обновлено ${report.moderationRefsUpdated}` : ''}`,
    );
  }
  if ((!only || only.includes('client_files')) && !skip.includes('client_files')) {
    await migrateClientFiles({ db, storage: createPrivateUploadStorage(cfg), apply, log: (l) => console.log(l) });
  }
} finally {
  await db.$disconnect();
}
