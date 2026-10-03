import { Inject, Injectable, Optional } from '@nestjs/common';
import { PRIVATE_STORAGE, UPLOAD_STORAGE } from '../../adapters/adapters.js';
import { storageConfig, type FileStorage, type StorageConfig } from '../../adapters/storage/storage.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { checkDocument, clientFileKey, CLIENT_FILE_KEY, DocumentError } from './document.js';
import { ImageError, processImage, thumbKeyOf, uploadKeys } from './image.js';

/** Кто владеет фото: бизнес (кабинет), человек (/v1/me), наша панель */
export type UploadOwner =
  | { kind: 'business'; businessId: string; by: string }
  | { kind: 'user'; userId: string }
  | { kind: 'platform'; by: string | null };

export interface UploadResult {
  id: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/** Сколько всего можно хранить человеку (аватар клиента), байт */
const USER_QUOTA_BYTES = 100 * 1024 * 1024;
/** Кэш навсегда: ключ — хеш содержимого, новый файл всегда получает новый адрес */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** Ровно то, чем сервис пользуется у Prisma — тесты подменяют */
type UploadsDb = Pick<PrismaService, 'upload'>;

/**
 * Фото (04.10.2026, «Файлы и фото»): проверка по сигнатуре, перекодирование (image.ts), запись основного файла и
 * превью в хранилище, строка `uploads` для владельца и квоты. Ответ — адреса, которые экран кладёт в те же поля,
 * где раньше лежал data: URL (поля по-прежнему принимают и старые data: URL).
 */
@Injectable()
export class UploadsService {
  /** Драйвер и публичный адрес бакета (тесты подменяют) */
  cfg: StorageConfig = storageConfig();

  constructor(
    @Inject(PrismaService) private readonly prisma: UploadsDb,
    @Inject(UPLOAD_STORAGE) private readonly storage: FileStorage,
    /** Закрытое хранилище документов клиентов — наружу не раздаётся */
    @Optional() @Inject(PRIVATE_STORAGE) private readonly privateStorage?: FileStorage,
  ) {}

  private get docs(): FileStorage {
    if (!this.privateStorage) throw new Error('private storage is not configured');
    return this.privateStorage;
  }

  /**
   * Документ клиента (04.10.2026): PDF / картинка / Word / Excel / текст до 10 МБ — тип по сигнатуре, файл как есть
   * (без перекодирования) в закрытое хранилище под client-files/<бизнес>/<hash>.<ext>, строка uploads для квоты и
   * уборки. Тот же файл того же бизнеса — тот же ключ и та же строка.
   */
  async storeDocument(
    owner: { businessId: string; by: string },
    file: { buffer: Buffer } | undefined,
    ext: string,
  ): Promise<{ key: string; mime: string; bytes: number }> {
    if (!file?.buffer?.length) throw new ApiError('file_required', 'Send the file in multipart field "file"');
    let doc;
    try {
      doc = checkDocument(file.buffer, ext);
    } catch (e) {
      if (e instanceof DocumentError) {
        if (e.reason === 'too_large') throw new ApiError('file_too_large', e.message);
        if (e.reason === 'empty') throw new ApiError('file_required', e.message);
        throw new ApiError('unsupported_file', e.message);
      }
      throw e;
    }
    const key = clientFileKey(owner.businessId, doc);
    const out = { key, mime: doc.mime, bytes: doc.bytes };
    const existing = await this.prisma.upload.findUnique({ where: { key } });
    if (!existing) await this.checkQuota({ kind: 'business', businessId: owner.businessId, by: owner.by }, doc.bytes);
    await this.docs.put(key, file.buffer, doc.mime, { cacheControl: 'private, no-store' });
    if (existing) {
      await this.touch(existing.id);
      return out;
    }
    try {
      await this.prisma.upload.create({
        data: { id: newId('upload'), businessId: owner.businessId, userId: null, key, mime: doc.mime, bytes: doc.bytes, width: 0, height: 0, createdBy: owner.by },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
    return out;
  }

  /** Содержимое документа клиента по ключу (только ключи client-files/…); нет — null */
  async readDocument(key: string): Promise<Buffer | null> {
    if (!CLIENT_FILE_KEY.test(key)) return null;
    return this.docs.get(key);
  }

  /** Внешний адрес файла: публичный бакет (S3_PUBLIC_URL) или раздача через API */
  urlOf(key: string, requestBase: string): string {
    if (this.cfg.driver === 's3' && this.cfg.publicUrl) return `${this.cfg.publicUrl}/${key}`;
    const base = (env.PUBLIC_API_URL || requestBase).replace(/\/+$/, '');
    return `${base}/v1/files/${key}`;
  }

  async upload(owner: UploadOwner, file: { buffer: Buffer } | undefined, requestBase: string): Promise<UploadResult> {
    if (!file?.buffer?.length) throw new ApiError('file_required', 'Send the image in multipart field "file"');
    let img;
    try {
      img = await processImage(file.buffer);
    } catch (e) {
      if (e instanceof ImageError) {
        if (e.reason === 'too_large') throw new ApiError('file_too_large', e.message);
        throw new ApiError('unsupported_image', e.message);
      }
      throw e;
    }
    const ownerSeg = owner.kind === 'business' ? owner.businessId : owner.kind === 'user' ? owner.userId : 'platform';
    const { key, thumbKey } = uploadKeys(ownerSeg, img);
    const bytes = img.main.length + img.thumb.length;
    const view = (row: { id: string; key: string; width: number; height: number; bytes: number }): UploadResult => ({
      id: row.id,
      url: this.urlOf(row.key, requestBase),
      thumbUrl: this.urlOf(thumbKeyOf(row.key), requestBase),
      width: row.width,
      height: row.height,
      bytes: row.bytes,
    });

    // Тот же файл у того же владельца — та же строка (повторная загрузка не съедает квоту)
    const existing = await this.prisma.upload.findUnique({ where: { key } });
    if (existing) {
      await this.putFiles(key, thumbKey, img);
      await this.touch(existing.id);
      return view(existing);
    }
    await this.checkQuota(owner, bytes);
    await this.putFiles(key, thumbKey, img);
    try {
      const row = await this.prisma.upload.create({
        data: {
          id: newId('upload'),
          businessId: owner.kind === 'business' ? owner.businessId : null,
          userId: owner.kind === 'user' ? owner.userId : null,
          key,
          mime: img.mime,
          bytes,
          width: img.width,
          height: img.height,
          createdBy: owner.kind === 'user' ? owner.userId : owner.by,
        },
      });
      return view(row);
    } catch (e) {
      // Две одинаковые загрузки одновременно: вторая видит строку первой
      if ((e as { code?: string }).code === 'P2002') {
        const row = await this.prisma.upload.findUnique({ where: { key } });
        if (row) return view(row);
      }
      throw e;
    }
  }

  /**
   * Тот же файл загрузили снова: created_at = сейчас. Уборка (jobs/uploads-cleanup.ts) удаляет только строки старше
   * 7 дней без ссылок — иначе старое неиспользуемое фото, загруженное повторно прямо перед уборкой, исчезло бы
   * до того, как форму сохранят.
   */
  private async touch(id: string): Promise<void> {
    await this.prisma.upload.update({ where: { id }, data: { createdAt: new Date() } });
  }

  private async putFiles(key: string, thumbKey: string, img: { main: Buffer; thumb: Buffer; mime: string }): Promise<void> {
    await this.storage.put(key, img.main, img.mime, { cacheControl: IMMUTABLE_CACHE });
    await this.storage.put(thumbKey, img.thumb, img.mime, { cacheControl: IMMUTABLE_CACHE });
  }

  private async checkQuota(owner: UploadOwner, adding: number): Promise<void> {
    if (owner.kind === 'platform') return;
    const where = owner.kind === 'business' ? { businessId: owner.businessId } : { userId: owner.userId };
    const limit = owner.kind === 'business' ? env.UPLOADS_QUOTA_MB * 1024 * 1024 : USER_QUOTA_BYTES;
    const agg = await this.prisma.upload.aggregate({ where, _sum: { bytes: true } });
    const used = agg._sum.bytes ?? 0;
    if (used + adding > limit) throw new ApiError('upload_quota', `Storage quota exceeded (${Math.round(limit / 1024 / 1024)} MB)`);
  }
}
