/**
 * Файлы и фото (04.10.2026): сигнатуры картинок, предел 10 МБ, перекодирование без EXIF, ключи без выхода за корень,
 * диск туда-обратно, S3 с подменённым клиентом, квота, права маршрутов и раздача /v1/files. Запуск: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { sniffImage, processImage, ImageError, MAX_UPLOAD_BYTES, UPLOAD_KEY, uploadKeys, thumbKeyOf } = await import('./image.js');
const { LocalFileStorage, S3FileStorage, isSafeKey, storageConfig } = await import('../../adapters/storage/storage.js');
const { UploadsService } = await import('./uploads.service.js');
const { UploadsController, FilesController, requestBase } = await import('./uploads.controller.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const { BizGuard, SessionGuard, PlatformGuard } = await import('../../common/http/guards.js');
const { RateLimitGuard } = await import('../../common/rate-limit/rate-limit.js');
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

const png = (w: number, h: number, alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 10, b: 10, alpha: 0.5 } : { r: 20, g: 120, b: 200 } } })
    .png()
    .toBuffer();

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bt-uploads-'));
}

// ─────────────────────────── сигнатуры ───────────────────────────

test('sniffImage: тип по первым байтам, а не по имени или заголовку', async () => {
  assert.equal(sniffImage(await png(4, 4)), 'png');
  assert.equal(sniffImage(await sharp(await png(4, 4)).jpeg().toBuffer()), 'jpeg');
  assert.equal(sniffImage(await sharp(await png(4, 4)).webp().toBuffer()), 'webp');
  assert.equal(sniffImage(await sharp(await png(4, 4)).gif().toBuffer()), 'gif');
  assert.equal(sniffImage(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'binary')), 'heic');
  // AVIF — тоже ISO BMFF, но не из списка
  assert.equal(sniffImage(Buffer.from('\0\0\0\x18ftypavif\0\0\0\0', 'binary')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
});

test('processImage: HTML под видом картинки и битый JPEG — unsupported/broken', async () => {
  await assert.rejects(processImage(Buffer.from('GIF89a<script>alert(1)</script>'.padEnd(64, ' '))), (e) => e instanceof ImageError);
  await assert.rejects(processImage(Buffer.from('not an image at all, sorry')), (e) => e instanceof ImageError && e.reason === 'unsupported');
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
  await assert.rejects(processImage(broken), (e) => e instanceof ImageError && e.reason === 'broken');
});

test('processImage: больше 10 МБ — too_large, до разбора', async () => {
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0);
  big.set([0xff, 0xd8, 0xff], 0);
  await assert.rejects(processImage(big), (e) => e instanceof ImageError && e.reason === 'too_large');
});

test('processImage: длинная сторона ≤ 2048, превью ≤ 512, прозрачность → WebP, иначе JPEG', async () => {
  const opaque = await processImage(await png(3000, 1000));
  assert.equal(opaque.ext, 'jpg');
  assert.equal(opaque.mime, 'image/jpeg');
  assert.deepEqual([opaque.width, opaque.height], [2048, 683]);
  const tm = await sharp(opaque.thumb).metadata();
  assert.equal(Math.max(tm.width!, tm.height!), 512);
  assert.match(opaque.hash, /^[0-9a-f]{32}$/);

  const logo = await processImage(await png(300, 200, true));
  assert.equal(logo.ext, 'webp');
  assert.deepEqual([logo.width, logo.height], [300, 200]); // маленькую не увеличиваем
  assert.equal((await sharp(logo.main).metadata()).hasAlpha, true);
});

test('processImage: EXIF и GPS не сохраняются, поворот по EXIF применён', async () => {
  const withExif = await sharp(await png(400, 200))
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 11/1 0/1' } } })
    .toBuffer();
  const src = await sharp(withExif).metadata();
  assert.ok(src.exif, 'исходник с EXIF');
  const out = await processImage(withExif);
  const meta = await sharp(out.main).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
  assert.ok(!out.main.includes(Buffer.from('secret-owner')));
  // orientation 6 = повернуть на 90°: 400×200 становится 200×400
  assert.deepEqual([out.width, out.height], [200, 400]);
});

// ─────────────────────────── ключи ───────────────────────────

test('ключи: выйти за корень нельзя', async () => {
  for (const bad of ['../etc/passwd', 'a/../../x', '/abs', 'a//b', 'a/./b', '.hidden', 'a\\b', 'a/b/', '', 'x'.repeat(301), 'a/..']) {
    assert.equal(isSafeKey(bad), false, bad);
  }
  assert.equal(isSafeKey('report-exports/biz_1/rx_01.csv'), true);
  const disk = new LocalFileStorage(await tmpDir());
  assert.throws(() => disk.file('../outside.txt'), RangeError);
  assert.throws(() => disk.file('a/../../outside.txt'), RangeError);

  const { key, thumbKey } = uploadKeys('../../etc', { hash: 'a'.repeat(32), ext: 'jpg' });
  assert.equal(key, `uploads/______etc/${'a'.repeat(32)}.jpg`);
  assert.match(key, UPLOAD_KEY);
  assert.match(thumbKey, UPLOAD_KEY);
  assert.equal(thumbKeyOf(key), thumbKey);
  for (const bad of ['uploads/../x/' + 'a'.repeat(32) + '.jpg', 'report-exports/biz/x.csv', 'uploads/biz/' + 'a'.repeat(32) + '.svg', 'uploads/biz/../../' + 'a'.repeat(32) + '.jpg']) {
    assert.doesNotMatch(bad, UPLOAD_KEY);
  }
});

// ─────────────────────────── драйверы ───────────────────────────

test('диск: запись → чтение → удаление; нет файла или это папка — null', async () => {
  const root = await tmpDir();
  const disk = new LocalFileStorage(root);
  await disk.put('uploads/biz_1/f.jpg', Buffer.from('hello'), 'image/jpeg');
  assert.equal((await disk.get('uploads/biz_1/f.jpg'))?.toString(), 'hello');
  assert.equal(await disk.get('uploads/biz_1/none.jpg'), null);
  assert.equal(await disk.get('uploads/biz_1'), null);
  assert.deepEqual(await fs.readdir(path.join(root, 'uploads/biz_1')), ['f.jpg']); // временных файлов не осталось
  await disk.delete('uploads/biz_1/f.jpg');
  assert.equal(await disk.get('uploads/biz_1/f.jpg'), null);
});

test('S3: команды с бакетом, ключом, типом и кэшем; NoSuchKey — null', async () => {
  const sent: unknown[] = [];
  const objects = new Map<string, Buffer>();
  const client = {
    async send(cmd: unknown) {
      sent.push(cmd);
      if (cmd instanceof PutObjectCommand) objects.set(cmd.input.Key!, cmd.input.Body as Buffer);
      if (cmd instanceof GetObjectCommand) {
        const body = objects.get(cmd.input.Key!);
        if (!body) throw Object.assign(new Error('nope'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (cmd instanceof DeleteObjectCommand) objects.delete(cmd.input.Key!);
      return {};
    },
  };
  const s3 = new S3FileStorage(client, 'bt-bucket');
  await s3.put('uploads/biz_1/a.jpg', Buffer.from('img'), 'image/jpeg', { cacheControl: 'public, max-age=1' });
  const put = sent[0] as InstanceType<typeof PutObjectCommand>;
  assert.equal(put.input.Bucket, 'bt-bucket');
  assert.equal(put.input.Key, 'uploads/biz_1/a.jpg');
  assert.equal(put.input.ContentType, 'image/jpeg');
  assert.equal(put.input.CacheControl, 'public, max-age=1');
  assert.equal((await s3.get('uploads/biz_1/a.jpg'))?.toString(), 'img');
  assert.equal(await s3.get('uploads/biz_1/none.jpg'), null);
  await s3.delete('uploads/biz_1/a.jpg');
  assert.equal(await s3.get('uploads/biz_1/a.jpg'), null);
  await assert.rejects(s3.put('../x', Buffer.from(''), 'image/jpeg'), RangeError);

  // Закрытые файлы — с префиксом private/
  const priv = new S3FileStorage(client, 'bt-bucket', 'private/');
  await priv.put('report-exports/b/x.csv', Buffer.from('a'), 'text/csv');
  assert.equal((sent.at(-1) as InstanceType<typeof PutObjectCommand>).input.Key, 'private/report-exports/b/x.csv');
});

test('storageConfig: четыре переменные S3 — S3; STORAGE_DRIVER=s3 без них — ошибка; иначе диск', () => {
  const base = {
    NODE_ENV: 'production' as const,
    STORAGE_DRIVER: 'local' as const,
    STORAGE_DIR: './storage',
    UPLOADS_DIR: undefined,
    S3_ENDPOINT: undefined,
    S3_REGION: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_ACCESS_KEY: undefined,
    S3_SECRET_KEY: undefined,
    S3_PUBLIC_URL: undefined,
    S3_FORCE_PATH_STYLE: true,
  };
  const disk = storageConfig(base);
  assert.equal(disk.driver, 'disk');
  assert.equal(disk.driver === 'disk' && disk.uploadsDir, '/data/uploads');
  const dev = storageConfig({ ...base, NODE_ENV: 'development' });
  assert.equal(dev.driver === 'disk' && dev.uploadsDir, path.resolve('./.uploads'));
  assert.throws(() => storageConfig({ ...base, STORAGE_DRIVER: 's3' }), /S3_BUCKET/);
  const s3 = storageConfig({ ...base, S3_BUCKET: 'b', S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', S3_ACCESS_KEY: 'old', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_URL: 'https://files.booktime.am/' });
  assert.equal(s3.driver, 's3');
  assert.equal(s3.driver === 's3' && s3.accessKeyId, 'old');
  assert.equal(s3.driver === 's3' && s3.publicUrl, 'https://files.booktime.am');
  assert.equal(s3.driver === 's3' && s3.region, 'auto');
});

// ─────────────────────────── сервис: квота, повтор, адреса ───────────────────────────

type Row = { id: string; businessId: string | null; userId: string | null; key: string; bytes: number; width: number; height: number };

function fakeDb(rows: Row[] = []) {
  return {
    rows,
    upload: {
      findUnique: async ({ where }: { where: { key: string } }) => rows.find((r) => r.key === where.key) ?? null,
      create: async ({ data }: { data: Row }) => (rows.push(data), data),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
      aggregate: async ({ where }: { where: Partial<Row> }) => ({
        _sum: { bytes: rows.filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v)).reduce((s, r) => s + r.bytes, 0) || null },
      }),
    },
  };
}

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

test('сервис: файл и превью в хранилище, строка uploads, адреса через API; повтор той же картинки — та же строка', async () => {
  const db = fakeDb();
  const storage = memStorage();
  const svc = new UploadsService(db as never, storage);
  svc.cfg = { driver: 'disk', uploadsDir: '/tmp/x', storageDir: '/tmp/y' };
  const file = { buffer: await png(800, 600) };
  const a = await svc.upload({ kind: 'business', businessId: 'biz_1', by: 'st_1' }, file, 'https://api.example.am');
  assert.match(a.url, /^https:\/\/api\.example\.am\/v1\/files\/uploads\/biz_1\/[0-9a-f]{32}\.jpg$/);
  assert.equal(a.thumbUrl, a.url.replace('.jpg', '_t.jpg'));
  assert.deepEqual([a.width, a.height], [800, 600]);
  assert.equal(storage.files.size, 2);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]!.businessId, 'biz_1');
  const again = await svc.upload({ kind: 'business', businessId: 'biz_1', by: 'st_1' }, file, 'https://api.example.am');
  assert.equal(again.id, a.id);
  assert.equal(db.rows.length, 1);

  // Публичный бакет — ссылка прямо туда
  svc.cfg = { driver: 's3', endpoint: 'e', region: 'auto', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true, publicUrl: 'https://files.booktime.am' };
  assert.equal(svc.urlOf('uploads/biz_1/x.jpg', 'https://api.example.am'), 'https://files.booktime.am/uploads/biz_1/x.jpg');
});

test('сервис: нет файла — file_required; не картинка — unsupported_image; квота — upload_quota', async () => {
  const db = fakeDb([{ id: 'upl_1', businessId: 'biz_1', userId: null, key: 'uploads/biz_1/old.jpg', bytes: 2048 * 1024 * 1024, width: 1, height: 1 }]);
  const svc = new UploadsService(db as never, memStorage());
  const owner = { kind: 'business' as const, businessId: 'biz_1', by: 'st_1' };
  await assert.rejects(svc.upload(owner, undefined, 'http://x'), (e) => e instanceof ApiError && e.code === 'file_required');
  await assert.rejects(svc.upload(owner, { buffer: Buffer.from('<svg onload=alert(1)>') }, 'http://x'), (e) => e instanceof ApiError && e.code === 'unsupported_image' && e.status === 415);
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 5);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(svc.upload(owner, { buffer: big }, 'http://x'), (e) => e instanceof ApiError && e.code === 'file_too_large' && e.status === 413);
  await assert.rejects(svc.upload(owner, { buffer: await png(50, 50) }, 'http://x'), (e) => e instanceof ApiError && e.code === 'upload_quota');
  // Квота у каждого бизнеса своя
  const other = await svc.upload({ kind: 'business', businessId: 'biz_2', by: 'st_9' }, { buffer: await png(50, 50) }, 'http://x');
  assert.match(other.url, /uploads\/biz_2\//);
});

// ─────────────────────────── права ───────────────────────────

const guardsOf = (proto: object, name: string): unknown[] => Reflect.getMetadata('__guards__', (proto as Record<string, object>)[name]!) ?? [];

test('права: кабинет — член бизнеса из пути, /me — вход, панель — сессия платформы; у всех лимит', () => {
  const p = UploadsController.prototype;
  assert.ok(guardsOf(p, 'biz').includes(BizGuard));
  assert.ok(guardsOf(p, 'me').includes(SessionGuard));
  assert.ok(guardsOf(p, 'platform').includes(PlatformGuard));
  for (const m of ['biz', 'me', 'platform']) assert.ok(guardsOf(p, m).includes(RateLimitGuard), m);
});

test('права: BizGuard не пускает в чужой бизнес и без входа', async () => {
  const memberships = { resolve: async (_s: unknown, businessId: string) => (businessId === 'biz_1' ? { businessId, staffId: 'st_1', permissions: new Set() } : null) };
  const reflector = { getAllAndOverride: () => [] };
  const guard = new BizGuard(reflector as never, memberships as never);
  const host = (session: unknown, businessId: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ ctx: { session }, params: { businessId } }) }),
      getHandler: () => null,
      getClass: () => null,
    }) as never;
  assert.equal(await guard.canActivate(host({ userId: 'au_1' }, 'biz_1')), true);
  await assert.rejects(guard.canActivate(host({ userId: 'au_1' }, 'biz_2')), (e) => e instanceof ApiError && e.code === 'forbidden');
  await assert.rejects(guard.canActivate(host(null, 'biz_1')), (e) => e instanceof ApiError && e.code === 'unauthorized');
});

// ─────────────────────────── раздача ───────────────────────────

function fakeRes() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 0,
    body: undefined as Buffer | undefined,
    headers,
    setHeader: (k: string, v: string) => void headers.set(k.toLowerCase(), v),
    removeHeader: (k: string) => void headers.delete(k.toLowerCase()),
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    end(b?: Buffer) {
      res.body = b;
    },
  };
  return res;
}
const req = (h: Record<string, string> = {}) => ({ header: (n: string) => h[n.toLowerCase()], protocol: 'http' }) as never;

test('/v1/files: отдаёт фото с типом, nosniff и вечным кэшем; чужие пути и выгрузки — 404', async () => {
  const storage = memStorage();
  const key = `uploads/biz_1/${'b'.repeat(32)}.webp`;
  storage.files.set(key, Buffer.from('webp-bytes'));
  storage.files.set('report-exports/biz_1/x.csv', Buffer.from('secret'));
  const ctrl = new FilesController(storage);
  const res = fakeRes();
  await ctrl.get(key.split('/'), req(), res as never);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.toString(), 'webp-bytes');
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control')!, /immutable/);

  const etag = res.headers.get('etag')!;
  const cached = fakeRes();
  await ctrl.get(key, req({ 'if-none-match': etag }), cached as never);
  assert.equal(cached.statusCode, 304);

  for (const bad of ['report-exports/biz_1/x.csv', `uploads/biz_1/../../${'b'.repeat(32)}.webp`, 'uploads/biz_1', 'uploads', `uploads/biz_1/${'c'.repeat(32)}.webp`]) {
    await assert.rejects(ctrl.get(bad.split('/'), req(), fakeRes() as never), (e) => e instanceof ApiError && e.code === 'not_found', bad);
  }
});

test('requestBase: адрес из заголовков прокси; мусор в Host — запасной localhost', () => {
  assert.equal(requestBase(req({ host: 'api.booktime.am', 'x-forwarded-proto': 'https' })), 'https://api.booktime.am');
  assert.equal(requestBase(req({ host: 'localhost:4010' })), 'http://localhost:4010');
  assert.match(requestBase(req({ host: 'evil.com/"><script>' })), /^http:\/\/localhost:\d+$/);
});

test('перенос data: URL: замена в строке, JSON и тексте; одна картинка — один вызов; неразобранная остаётся', async () => {
  const { rewriteDataUrls } = await import('./data-url-migration.js');
  const a = 'data:image/png;base64,iVBORw0KGgo=';
  const b = 'data:image/jpeg;base64,/9j/4AAQ==';
  const json = JSON.stringify({ logo: a, photos: [a, b, 'https://x/y.jpg'], text: 'data:text/plain;base64,QQ==' });
  const calls: string[] = [];
  const res = await rewriteDataUrls(json, async (d) => (calls.push(d), d === b ? null : 'https://api/v1/files/uploads/biz/1.jpg'));
  assert.deepEqual(calls.sort(), [a, b].sort());
  assert.equal(res.found, 2);
  assert.equal(res.replaced, 1);
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.logo, 'https://api/v1/files/uploads/biz/1.jpg');
  assert.deepEqual(parsed.photos, ['https://api/v1/files/uploads/biz/1.jpg', b, 'https://x/y.jpg']);
  assert.equal(parsed.text, 'data:text/plain;base64,QQ==');
  assert.deepEqual(await rewriteDataUrls('без картинок', async () => 'x'), { text: 'без картинок', found: 0, replaced: 0 });
});
