import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../common/config/env.js';

/**
 * Хранилище файлов (фото услуг, портфолио, аватары, выгрузки) — PLAN.md §2. local — папка на диске (разработка);
 * s3 — любое хранилище с API S3, подключается на этапе файлов (выбор хранилища вместо снятого с Docker Hub MinIO).
 */
export interface FileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[\w./-]{1,300}$/;

export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private file(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new RangeError(`bad storage key: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  async get(key: string): Promise<Buffer | null> {
    return fs.readFile(this.file(key)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

export function createFileStorage(): FileStorage {
  if (env.STORAGE_DRIVER === 's3') throw new Error('STORAGE_DRIVER=s3: адаптер S3 подключается на этапе файлов');
  return new LocalFileStorage(path.resolve(env.STORAGE_DIR));
}
