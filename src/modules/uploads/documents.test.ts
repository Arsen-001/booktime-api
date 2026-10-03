/**
 * Документы клиентов в закрытом хранилище и уборка неиспользуемых загрузок (04.10.2026): сигнатуры, хранение как
 * есть, права (чужой клиент — 404), раздача attachment + nosniff, старые data: URL, перенос client_files, поиск
 * ссылок по всей базе, уборка: пробный режим, 7 дней, ссылки. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { sniffDocument, checkDocument, clientFileKey, CLIENT_FILE_KEY, attachmentDisposition, MAX_DOCUMENT_BYTES } = await import('./document.js');
const { UploadsService } = await import('./uploads.service.js');
const { ClientsExtrasService } = await import('../clients/clients-extras.service.js');
const { ClientsController } = await import('../clients/clients.controller.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const { extractStorageKeys, collectReferencedKeys } = await import('./references.js');
const { uploadsCleanup } = await import('../../jobs/uploads-cleanup.js');
const { migrateClientFiles } = await import('./data-url-migration.js');
const { BizGuard } = await import('../../common/http/guards.js');

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....')]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40)]);
const H = 'a'.repeat(32);

function memStorage() {
  const files = new Map<string, Buffer>();
  return {
    files,
    driver: 'disk' as const,
    put: async (k: string, b: Buffer) => void files.set(k, b),
    get: async (k: string) => files.get(k) ?? null,
    delete: async (k: string) => void files.delete(k),
  };
}

type UploadRow = { id: string; businessId: string | null; key: string; bytes: number; mime: string; createdAt: Date };
function uploadsDb(rows: UploadRow[] = []) {
  return {
    rows,
    upload: {
      findUnique: async ({ where }: { where: { key: string } }) => rows.find((r) => r.key === where.key) ?? null,
      create: async ({ data }: { data: Omit<UploadRow, 'createdAt'> }) => (rows.push({ ...data, createdAt: new Date() }), data),
      update: async ({ where, data }: { where: { id: string }; data: Partial<UploadRow> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
      aggregate: async ({ where }: { where: { businessId: string } }) => ({
        _sum: { bytes: rows.filter((r) => r.businessId === where.businessId).reduce((s, r) => s + r.bytes, 0) || null },
      }),
    },
  };
}

// ─────────────────────────── сигнатуры ───────────────────────────

test('sniffDocument: тип по байтам; расширение только различает docx/xlsx и doc/xls', () => {
  assert.equal(sniffDocument(PDF, 'pdf'), 'pdf');
  assert.equal(sniffDocument(PDF, 'jpg'), 'pdf', 'имя врёт — верим байтам');
  assert.equal(sniffDocument(JPEG, 'jpeg'), 'jpg');
  assert.equal(sniffDocument(DOCX, 'docx'), 'docx');
  assert.equal(sniffDocument(DOCX, 'xlsx'), null, 'ZIP без xl/ — не таблица');
  assert.equal(sniffDocument(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('evil.exe')]), 'docx'), null);
  assert.equal(sniffDocument(OLE, 'xls'), 'xls');
  assert.equal(sniffDocument(OLE, 'pdf'), null);
  assert.equal(sniffDocument(Buffer.from('Привет, это заметка'), 'txt'), 'txt');
  assert.equal(sniffDocument(Buffer.from('Привет'), 'pdf'), null, 'текст только с .txt');
  assert.equal(sniffDocument(Buffer.from([0x41, 0x00, 0x42, 0x43]), 'txt'), null, 'двоичное под видом текста');
  assert.equal(sniffDocument(Buffer.from('<html><script>alert(1)</script></html>'), 'pdf'), null);
  assert.equal(sniffDocument(Buffer.from('<svg onload=alert(1)>'), 'png'), null);
});

test('checkDocument: пусто, больше 10 МБ, неизвестный тип; ключ client-files/<бизнес>/<hash>.<ext>', () => {
  assert.throws(() => checkDocument(Buffer.alloc(0), 'pdf'), /empty/);
  const big = Buffer.concat([PDF, Buffer.alloc(MAX_DOCUMENT_BYTES)]);
  assert.throws(() => checkDocument(big, 'pdf'), (e: Error & { reason?: string }) => e.reason === 'too_large');
  assert.throws(() => checkDocument(Buffer.from('MZ\x90\x00 windows exe'), 'pdf'), (e: Error & { reason?: string }) => e.reason === 'unsupported');
  const d = checkDocument(PDF, 'pdf');
  assert.equal(d.mime, 'application/pdf');
  const key = clientFileKey('biz_1', d);
  assert.match(key, CLIENT_FILE_KEY);
  assert.ok(key.startsWith('client-files/biz_1/'));
});

test('attachmentDisposition: кавычки и переводы строк не ломают заголовок, кириллица — filename*', () => {
  const v = attachmentDisposition('Анализ "крови"\r\n.pdf');
  assert.ok(v.startsWith('attachment; filename="'));
  assert.ok(!/[\r\n]/.test(v));
  assert.ok(v.includes("filename*=UTF-8''"));
  assert.ok(v.includes(encodeURIComponent('Анализ')));
});

// ─────────────────────────── хранение ───────────────────────────

test('storeDocument: PDF как есть в закрытое хранилище (не в хранилище фото), строка uploads; повтор — та же строка', async () => {
  const db = uploadsDb();
  const photos = memStorage();
  const priv = memStorage();
  const svc = new UploadsService(db as never, photos, priv);
  const a = await svc.storeDocument({ businessId: 'biz_1', by: 'st_1' }, { buffer: PDF }, 'pdf');
  assert.equal(photos.files.size, 0);
  assert.deepEqual(priv.files.get(a.key), PDF, 'байт в байт, без перекодирования');
  assert.equal(a.mime, 'application/pdf');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]!.businessId, 'biz_1');
  const old = new Date(Date.now() - 30 * 86_400_000);
  db.rows[0]!.createdAt = old;
  const b = await svc.storeDocument({ businessId: 'biz_1', by: 'st_1' }, { buffer: PDF }, 'pdf');
  assert.equal(b.key, a.key);
  assert.equal(db.rows.length, 1);
  assert.ok(db.rows[0]!.createdAt > old, 'повторная загрузка освежает created_at (уборка не удалит)');
  assert.deepEqual(await svc.readDocument(a.key), PDF);
  assert.equal(await svc.readDocument('uploads/biz_1/' + H + '.jpg'), null, 'фото через readDocument не читаются');
});

test('storeDocument: нет файла — file_required, exe — unsupported_file 415, квота — upload_quota', async () => {
  const db = uploadsDb([{ id: 'u0', businessId: 'biz_1', key: 'uploads/biz_1/x.jpg', bytes: 2048 * 1024 * 1024, mime: 'image/jpeg', createdAt: new Date() }]);
  const svc = new UploadsService(db as never, memStorage(), memStorage());
  const owner = { businessId: 'biz_1', by: 'st_1' };
  await assert.rejects(svc.storeDocument(owner, undefined, 'pdf'), (e) => e instanceof ApiError && e.code === 'file_required');
  await assert.rejects(svc.storeDocument({ businessId: 'biz_2', by: 's' }, { buffer: Buffer.from('MZ\x90\x00exe') }, 'pdf'), (e) => e instanceof ApiError && e.code === 'unsupported_file' && e.status === 415);
  await assert.rejects(svc.storeDocument(owner, { buffer: PDF }, 'pdf'), (e) => e instanceof ApiError && e.code === 'upload_quota');
});

// ─────────────────────────── карта клиента ───────────────────────────

function clientsSetup() {
  const files: Record<string, unknown>[] = [
    { id: 'cf_old', clientId: 'cl_1', name: 'старый.pdf', ext: 'pdf', size: PDF.length, dataUrl: `data:application/pdf;base64,${PDF.toString('base64')}`, storageKey: null, mime: null, uploadedAt: new Date(), uploadedBy: 'Анна' },
    { id: 'cf_html', clientId: 'cl_1', name: 'x.txt', ext: 'txt', size: 10, dataUrl: `data:text/html;base64,${Buffer.from('<script>1</script>').toString('base64')}`, storageKey: null, mime: null, uploadedAt: new Date(), uploadedBy: 'Анна' },
  ];
  const clients = [{ id: 'cl_1', businessId: 'biz_1' }, { id: 'cl_9', businessId: 'biz_9' }];
  const prisma = {
    client: { findFirst: async ({ where }: { where: { id: string; businessId: string } }) => clients.find((c) => c.id === where.id && c.businessId === where.businessId) ?? null },
    clientFile: {
      findMany: async ({ where }: { where: { clientId: string } }) => files.filter((f) => f.clientId === where.clientId),
      findFirst: async ({ where }: { where: { id: string; clientId: string } }) => files.find((f) => f.id === where.id && f.clientId === where.clientId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { uploadedAt: new Date(), storageKey: null, mime: null, ...data };
        files.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { id: string; clientId: string } }) => {
        const i = files.findIndex((f) => f.id === where.id && f.clientId === where.clientId);
        if (i >= 0) files.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
  };
  const priv = memStorage();
  const uploads = new UploadsService(uploadsDb() as never, memStorage(), priv);
  const extras = new ClientsExtrasService(prisma as never, uploads);
  const ctx = { member: { staffId: 'st_1', name: 'Анна', businessId: 'biz_1' } } as never;
  return { files, priv, extras, ctx };
}

function fakeRes() {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: Buffer | undefined;
  const res = {
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    status: (s: number) => ((status = s), res),
    end: (b?: Buffer) => void (body = b),
  };
  return { res, headers, status: () => status, body: () => body };
}

test('загрузка файлом: строка со storage_key, dataUrl = contentUrl (прежние сборки), файл в закрытом хранилище', async () => {
  const { extras, ctx, priv, files } = clientsSetup();
  const v = await extras.uploadFile(ctx, 'biz_1', 'cl_1', { buffer: PDF, originalname: 'Договор.pdf' }, undefined, 'https://api.example.am');
  assert.equal(v.stored, true);
  assert.equal(v.mime, 'application/pdf');
  assert.equal(v.name, 'Договор.pdf');
  assert.equal(v.contentUrl, `https://api.example.am/v1/biz/biz_1/clients/cl_1/files/${v.id}/content`);
  assert.equal(v.dataUrl, v.contentUrl);
  assert.equal(priv.files.size, 1);
  assert.equal((files.at(-1) as { dataUrl: unknown }).dataUrl, null, 'в базе больше нет data: URL');
  await assert.rejects(extras.uploadFile(ctx, 'biz_1', 'cl_1', { buffer: PDF, originalname: 'a.exe' }, undefined, 'x'), (e) => e instanceof ApiError && e.code === 'bad_ext');
});

test('чужой клиент (другой бизнес) — 404 на список, загрузку, скачивание и удаление', async () => {
  const { extras, ctx } = clientsSetup();
  const nf = (e: unknown) => e instanceof ApiError && e.code === 'not_found';
  await assert.rejects(extras.listFiles('biz_1', 'cl_9', 'x'), nf);
  await assert.rejects(extras.uploadFile(ctx, 'biz_1', 'cl_9', { buffer: PDF, originalname: 'a.pdf' }, undefined, 'x'), nf);
  await assert.rejects(extras.fileContent('biz_1', 'cl_9', 'cf_old'), nf);
  await assert.rejects(extras.fileContent('biz_9', 'cl_1', 'cf_old'), nf);
  await assert.rejects(extras.deleteFile('biz_1', 'cl_9', 'cf_old'), nf);
});

test('скачивание: attachment, nosniff, no-store, тип; старый data: URL раскодируется; text/html старой строки → octet-stream', async () => {
  const { extras, ctx } = clientsSetup();
  const ctrl = new ClientsController({} as never, extras, {} as never, {} as never);
  const up = await extras.uploadFile(ctx, 'biz_1', 'cl_1', { buffer: PDF, originalname: 'Анализы.pdf' }, undefined, 'x');
  const r = fakeRes();
  await ctrl.fileContent('biz_1', 'cl_1', up.id, r.res as never);
  assert.equal(r.status(), 200);
  assert.deepEqual(r.body(), PDF);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.match(r.headers['content-disposition']!, /^attachment; /);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert.match(r.headers['content-security-policy']!, /sandbox/);

  const old = fakeRes();
  await ctrl.fileContent('biz_1', 'cl_1', 'cf_old', old.res as never);
  assert.deepEqual(old.body(), PDF);
  assert.equal(old.headers['content-type'], 'application/pdf');
  const html = fakeRes();
  await ctrl.fileContent('biz_1', 'cl_1', 'cf_html', html.res as never);
  assert.equal(html.headers['content-type'], 'application/octet-stream');

  // Список: старые строки — data: URL как был, новые — адрес скачивания
  const list = await extras.listFiles('biz_1', 'cl_1', 'https://api.example.am');
  assert.ok(list.find((f) => f.id === 'cf_old')!.dataUrl.startsWith('data:application/pdf'));
  assert.equal(list.find((f) => f.id === 'cf_old')!.stored, false);
});

test('маршруты файлов: скачивание и список — clients.view, загрузка и удаление — clients.edit', () => {
  const handler = (name: string) => (ClientsController.prototype as unknown as Record<string, object>)[name]!;
  const guards = (name: string): unknown[] => Reflect.getMetadata('__guards__', handler(name)) ?? [];
  const perms = (name: string): unknown => Reflect.getMetadata('bt:required-permissions', handler(name));
  for (const m of ['fileContent', 'listFiles', 'uploadFile', 'deleteFile']) assert.ok(guards(m).includes(BizGuard), m);
  assert.deepEqual(perms('fileContent'), ['clients.view']);
  assert.deepEqual(perms('listFiles'), ['clients.view']);
  assert.deepEqual(perms('uploadFile'), ['clients.edit']);
  assert.deepEqual(perms('deleteFile'), ['clients.edit']);
});

// ─────────────────────────── перенос client_files ───────────────────────────

test('migrateClientFiles: без apply — только отчёт; с apply — файл как есть в закрытое хранилище, data_url очищен', async () => {
  const rows = [
    { id: 'cf_1', ext: 'pdf', data_url: `data:application/pdf;base64,${PDF.toString('base64')}`, business_id: 'biz_1' },
    { id: 'cf_2', ext: 'pdf', data_url: `data:application/pdf;base64,${Buffer.from('not a pdf').toString('base64')}`, business_id: 'biz_1' },
  ];
  const exec: [string, unknown[]][] = [];
  const db = {
    $queryRawUnsafe: async (sql: string, ...vals: unknown[]) => (sql.includes('LEFT JOIN') ? rows.filter((r) => r.id === vals[0]) : rows.map((r) => ({ id: r.id }))),
    $executeRawUnsafe: async (sql: string, ...vals: unknown[]) => (exec.push([sql, vals]), 1),
  };
  const storage = memStorage();
  const dry = await migrateClientFiles({ db: db as never, storage, apply: false });
  assert.deepEqual([dry.rows, dry.moved, dry.failed], [2, 1, 1]);
  assert.equal(storage.files.size, 0);
  assert.equal(exec.length, 0);
  const real = await migrateClientFiles({ db: db as never, storage, apply: true });
  assert.equal(real.moved, 1);
  const [key, buf] = [...storage.files.entries()][0]!;
  assert.match(key, /^client-files\/biz_1\/[0-9a-f]{32}\.pdf$/);
  assert.deepEqual(buf, PDF);
  const upd = exec.find(([sql]) => sql.startsWith('UPDATE `client_files`'))!;
  assert.deepEqual(upd[1], [key, 'application/pdf', PDF.length, 'cf_1']);
  assert.ok(upd[0].includes('`data_url` = NULL'));
});

// ─────────────────────────── ссылки и уборка ───────────────────────────

test('extractStorageKeys: адреса API и бакета, превью → основной ключ, документы; мусор не ловится', () => {
  const text = JSON.stringify({
    logo: `https://api.booktime.am/v1/files/uploads/biz_1/${H}.jpg`,
    thumb: `https://files.booktime.am/uploads/biz_1/${'b'.repeat(32)}_t.webp`,
    doc: `client-files/biz_1/${'c'.repeat(32)}.pdf`,
    junk: 'uploads/biz_1/short.jpg',
  });
  assert.deepEqual(extractStorageKeys(text).sort(), [`client-files/biz_1/${'c'.repeat(32)}.pdf`, `uploads/biz_1/${H}.jpg`, `uploads/biz_1/${'b'.repeat(32)}.webp`].sort());
});

/** Мини-база для поиска ссылок: таблица → колонки → значения */
function refsDb(tables: Record<string, Record<string, (string | null)[]>>, opts: { fail?: boolean } = {}) {
  return {
    $queryRawUnsafe: async (sql: string) => {
      if (opts.fail && sql.includes('LIKE')) throw new Error('db down');
      if (sql.includes('information_schema.COLUMNS'))
        return Object.entries(tables).flatMap(([t, cols]) => Object.keys(cols).map((c) => ({ t, c, dt: c === 'settings' ? 'json' : 'text' })));
      if (sql.includes('KEY_COLUMN_USAGE')) return Object.keys(tables).map((t) => ({ t, c: 'id' }));
      const m = /AS v FROM `(\w+)`/.exec(sql)!;
      const col = /SELECT (?:CAST\()?`(\w+)`/.exec(sql)![1]!;
      const offset = Number(/OFFSET (\d+)/.exec(sql)![1]);
      const vals = (tables[m[1]!]![col] ?? []).filter((v): v is string => typeof v === 'string' && (v.includes('uploads/') || v.includes('client-files/')));
      return vals.slice(offset, offset + 1000).map((v) => ({ v }));
    },
    $executeRawUnsafe: async () => 0,
  };
}

test('collectReferencedKeys: ищет во всех таблицах и JSON, кроме журналов изменений', async () => {
  const k1 = `uploads/biz_1/${'1'.repeat(32)}.jpg`;
  const k2 = `uploads/biz_1/${'2'.repeat(32)}.jpg`;
  const k3 = `client-files/biz_1/${'3'.repeat(32)}.pdf`;
  const db = refsDb({
    businesses: { id: ['biz_1'], settings: [JSON.stringify({ gallery: [`https://api/v1/files/${k1}`] })] },
    client_files: { id: ['cf_1'], storage_key: [k3] },
    audit_events: { id: ['ae_1'], diff: [`{"before":"https://api/v1/files/${k2}"}`] },
  });
  const { keys } = await collectReferencedKeys(db as never);
  assert.ok(keys.has(k1));
  assert.ok(keys.has(k3));
  assert.ok(!keys.has(k2), 'старый адрес в журнале изменений — не ссылка');
});

function cleanupDb(uploads: { id: string; key: string; bytes: number; createdAt: Date }[], tables: Record<string, Record<string, (string | null)[]>>, opts: { fail?: boolean } = {}) {
  return {
    ...refsDb(tables, opts),
    uploads,
    upload: {
      findMany: async ({ where, take }: { where: { createdAt: { lt: Date } }; take: number }) => uploads.filter((u) => u.createdAt < where.createdAt.lt).slice(0, take),
      deleteMany: async ({ where }: { where: { id: string; createdAt: { lt: Date } } }) => {
        const i = uploads.findIndex((u) => u.id === where.id && u.createdAt < where.createdAt.lt);
        if (i >= 0) uploads.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
  };
}

function cleanupFixture(opts: { fail?: boolean } = {}) {
  const NOW = Date.UTC(2026, 9, 20);
  const day = 86_400_000;
  const kUsed = `uploads/biz_1/${'1'.repeat(32)}.jpg`;
  const kOrphan = `uploads/biz_1/${'2'.repeat(32)}.jpg`;
  const kFresh = `uploads/biz_1/${'3'.repeat(32)}.jpg`;
  const kDocUsed = `client-files/biz_1/${'4'.repeat(32)}.pdf`;
  const kDocOrphan = `client-files/biz_1/${'5'.repeat(32)}.pdf`;
  const uploads = [
    { id: 'u1', key: kUsed, bytes: 10, createdAt: new Date(NOW - 30 * day) },
    { id: 'u2', key: kOrphan, bytes: 20, createdAt: new Date(NOW - 8 * day) },
    { id: 'u3', key: kFresh, bytes: 30, createdAt: new Date(NOW - 6 * day) },
    { id: 'u4', key: kDocUsed, bytes: 40, createdAt: new Date(NOW - 30 * day) },
    { id: 'u5', key: kDocOrphan, bytes: 50, createdAt: new Date(NOW - 30 * day) },
  ];
  const db = cleanupDb(uploads, { staff: { id: ['st_1'], photo_url: [`https://files.booktime.am/${kUsed.replace('.jpg', '_t.jpg')}`] }, client_files: { id: ['cf_1'], storage_key: [kDocUsed] } }, opts);
  const images = memStorage();
  const documents = memStorage();
  for (const u of uploads) {
    if (u.key.startsWith('client-files/')) documents.files.set(u.key, Buffer.from('d'));
    else (images.files.set(u.key, Buffer.from('i')), images.files.set(u.key.replace('.jpg', '_t.jpg'), Buffer.from('t')));
  }
  return { NOW, db, images, documents, kUsed, kOrphan, kFresh, kDocUsed, kDocOrphan };
}

test('уборка, пробный режим (по умолчанию): находит старые файлы без ссылок, ничего не удаляет', async () => {
  const f = cleanupFixture();
  const res = await uploadsCleanup(f.db as never, { images: f.images, documents: f.documents }, { apply: false, now: f.NOW });
  assert.equal(res.apply, false);
  assert.equal(res.candidates, 4, 'файл моложе 7 дней даже не кандидат');
  assert.equal(res.unreferenced, 2);
  assert.deepEqual(res.sample.sort(), [f.kDocOrphan, f.kOrphan].sort());
  assert.equal(res.bytes, 70);
  assert.equal(res.deleted, 0);
  assert.equal(f.db.uploads.length, 5);
  assert.equal(f.images.files.size, 6);
  assert.equal(f.documents.files.size, 2);
});

test('уборка с UPLOADS_CLEANUP=1: удаляет строку, файл и превью; используемые и свежие остаются', async () => {
  const f = cleanupFixture();
  const res = await uploadsCleanup(f.db as never, { images: f.images, documents: f.documents }, { apply: true, now: f.NOW });
  assert.equal(res.deleted, 2);
  assert.deepEqual(f.db.uploads.map((u) => u.id).sort(), ['u1', 'u3', 'u4']);
  assert.ok(!f.images.files.has(f.kOrphan) && !f.images.files.has(f.kOrphan.replace('.jpg', '_t.jpg')));
  assert.ok(f.images.files.has(f.kUsed) && f.images.files.has(f.kFresh));
  assert.ok(!f.documents.files.has(f.kDocOrphan));
  assert.ok(f.documents.files.has(f.kDocUsed));
});

test('уборка: поиск ссылок упал — ничего не удалено (ошибка наружу)', async () => {
  const f = cleanupFixture({ fail: true });
  await assert.rejects(uploadsCleanup(f.db as never, { images: f.images, documents: f.documents }, { apply: true, now: f.NOW }), /db down/);
  assert.equal(f.db.uploads.length, 5);
  assert.equal(f.images.files.size, 6);
});
