import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env, type Env } from '../../common/config/env.js';

/**
 * Хранилище файлов (фото, выгрузки отчётов) — PLAN.md §2, «Файлы и фото» (04.10.2026).
 * Два драйвера: диск (папка; Railway — постоянный диск /data) и любое хранилище с API S3 (AWS S3, Cloudflare R2,
 * Railway Buckets). Выбор — storageConfig(): заданы четыре переменные S3 — S3, иначе диск.
 */
export interface FileStorage {
  readonly driver: 'disk' | 's3';
  put(key: string, body: Buffer, contentType: string, opts?: { cacheControl?: string }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Ключ: буквы, цифры, «_», «-», «.», «/»; без «..», без ведущего «/» и пустых частей — выйти за корень нельзя */
const SAFE_KEY = /^[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*$/;

export function isSafeKey(key: string): boolean {
  return key.length > 0 && key.length <= 300 && SAFE_KEY.test(key);
}

function assertKey(key: string): void {
  if (!isSafeKey(key)) throw new RangeError(`bad storage key: ${key}`);
}

export class LocalFileStorage implements FileStorage {
  readonly driver = 'disk' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Путь файла — только внутри корня (вторая проверка поверх SAFE_KEY) */
  file(key: string): string {
    assertKey(key);
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new RangeError(`bad storage key: ${key}`);
    return file;
  }

  /** Тип и кэш на диске не хранятся: раздача /v1/files знает их по расширению ключа */
  async put(key: string, body: Buffer, _contentType?: string, _opts?: { cacheControl?: string }): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Сначала во временный файл, потом rename: читатель никогда не видит половину файла
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.file(key);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) return null;
      return await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

/** Ровно то, чем S3FileStorage пользуется у S3Client — в тестах подменяется */
export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

export class S3FileStorage implements FileStorage {
  readonly driver = 's3' as const;

  constructor(
    private readonly client: S3Like,
    private readonly bucket: string,
    /** Префикс ключей внутри бакета ('' — без префикса) */
    private readonly prefix = '',
  ) {}

  private k(key: string): string {
    assertKey(key);
    return this.prefix + key;
  }

  async put(key: string, body: Buffer, contentType: string, opts: { cacheControl?: string } = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType, CacheControl: opts.cacheControl }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }
}

export type StorageConfig =
  | { driver: 'disk'; uploadsDir: string; storageDir: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
      publicUrl: string | null;
    };

type StorageEnv = Pick<
  Env,
  | 'NODE_ENV'
  | 'STORAGE_DRIVER'
  | 'STORAGE_DIR'
  | 'UPLOADS_DIR'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_PUBLIC_URL'
  | 'S3_FORCE_PATH_STYLE'
>;

/** Какой драйвер и с чем: все четыре переменные S3 — S3; STORAGE_DRIVER=s3 без них — ошибка конфигурации */
export function storageConfig(e: StorageEnv = env): StorageConfig {
  const accessKeyId = e.S3_ACCESS_KEY_ID || e.S3_ACCESS_KEY;
  const secretAccessKey = e.S3_SECRET_ACCESS_KEY || e.S3_SECRET_KEY;
  if (e.S3_BUCKET && e.S3_ENDPOINT && accessKeyId && secretAccessKey) {
    return {
      driver: 's3',
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION || 'auto',
      bucket: e.S3_BUCKET,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      publicUrl: e.S3_PUBLIC_URL ? e.S3_PUBLIC_URL.replace(/\/+$/, '') : null,
    };
  }
  if (e.STORAGE_DRIVER === 's3') {
    throw new Error('STORAGE_DRIVER=s3: нужны S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  }
  return {
    driver: 'disk',
    uploadsDir: path.resolve(e.UPLOADS_DIR || (e.NODE_ENV === 'production' ? '/data/uploads' : './.uploads')),
    storageDir: path.resolve(e.STORAGE_DIR),
  };
}

let s3: S3Client | null = null;
function s3Client(cfg: Extract<StorageConfig, { driver: 's3' }>): S3Client {
  s3 ??= new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return s3;
}

/**
 * Выгрузки отчётов и прочие служебные файлы (наружу не раздаются). Бакет с S3_PUBLIC_URL открыт на чтение всем —
 * тогда выгрузки остаются на диске (STORAGE_DIR), в публичный бакет кладутся только фото.
 */
export function createFileStorage(cfg: StorageConfig = storageConfig()): FileStorage {
  if (cfg.driver === 's3' && !cfg.publicUrl) return new S3FileStorage(s3Client(cfg), cfg.bucket, 'private/');
  return new LocalFileStorage(cfg.driver === 'disk' ? cfg.storageDir : path.resolve(env.STORAGE_DIR));
}

/** Фото (раздаются GET /v1/files/<key> или прямо из бакета по S3_PUBLIC_URL) */
export function createUploadStorage(cfg: StorageConfig = storageConfig()): FileStorage {
  return cfg.driver === 's3' ? new S3FileStorage(s3Client(cfg), cfg.bucket) : new LocalFileStorage(cfg.uploadsDir);
}
