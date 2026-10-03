import { Controller, Get, Inject, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags, type ApiBodyOptions } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UPLOAD_STORAGE } from '../../adapters/adapters.js';
import type { FileStorage } from '../../adapters/storage/storage.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx, Platform } from '../../common/http/guards.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { MAX_UPLOAD_BYTES, mimeOfKey, UPLOAD_KEY } from './image.js';
import { IMMUTABLE_CACHE, UploadsService } from './uploads.service.js';

/** Файл из multer (memoryStorage по умолчанию) — только то, что нужно */
interface UploadedImage {
  buffer: Buffer;
  size: number;
}

/** Один файл в поле file, не больше 10 МБ (больше — multer → 413 file_too_large), других файлов нет */
const fileInterceptor = () => FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6 } });

/** Одна корзина на все загрузки: 60 фото за 10 минут на сессию */
const uploadRate = () => RateLimit({ bucket: 'uploads', limit: 60, windowSec: 600, by: 'session' });

const uploadBody: ApiBodyOptions = {
  schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
};

/** Адрес API, по которому пришёл запрос (для ссылок на файлы, если PUBLIC_API_URL не задан) */
export function requestBase(req: Pick<Request, 'header' | 'protocol'>): string {
  const first = (v: string | undefined) => v?.split(',')[0]?.trim();
  const proto = first(req.header('x-forwarded-proto')) ?? req.protocol;
  const host = first(req.header('x-forwarded-host')) ?? first(req.header('host'));
  if (!host || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) || !/^https?$/.test(proto ?? '')) return `http://localhost:${env.PORT}`;
  return `${proto}://${host}`;
}

@ApiTags('uploads')
@Controller()
export class UploadsController {
  constructor(private readonly svc: UploadsService) {}

  @Post('v1/biz/:businessId/uploads')
  @Biz()
  @uploadRate()
  @UseInterceptors(fileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({
    summary: 'Фото бизнеса (логотип, фото салона/мастера/услуги, сторис, заказы): JPEG/PNG/WebP/GIF до 10 МБ → { id, url, thumbUrl, width, height, bytes }',
  })
  biz(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @UploadedFile() file: UploadedImage | undefined, @Req() req: Request) {
    return this.svc.upload({ kind: 'business', businessId, by: ctx.member!.staffId }, file, requestBase(req));
  }

  @Post('v1/me/uploads')
  @Authed()
  @uploadRate()
  @UseInterceptors(fileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({ summary: 'Фото человека (аватар в профиле клиента)' })
  me(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedImage | undefined, @Req() req: Request) {
    return this.svc.upload({ kind: 'user', userId: ctx.session!.userId }, file, requestBase(req));
  }

  @Post('v1/platform/uploads')
  @Platform()
  @uploadRate()
  @UseInterceptors(fileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody)
  @ApiOperation({ summary: 'Фото нашей панели (реклама, мастер подключения салона)' })
  platform(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedImage | undefined, @Req() req: Request) {
    return this.svc.upload({ kind: 'platform', by: ctx.session!.platformMemberId }, file, requestBase(req));
  }
}

/**
 * Раздача фото с диска (или из закрытого бакета): GET /v1/files/uploads/<владелец>/<hash>.<jpg|webp>.
 * Только ключи вида UPLOAD_KEY — выгрузки отчётов и любые другие пути недоступны, «..» невозможен, списка папок нет.
 * Ключ — хеш содержимого, поэтому кэш навсегда (immutable).
 */
@ApiTags('uploads')
@Controller('v1/files')
export class FilesController {
  constructor(@Inject(UPLOAD_STORAGE) private readonly storage: FileStorage) {}

  @Get('*path')
  @ApiOperation({ summary: 'Файл фото по ключу из url загрузки' })
  async get(@Param('path') path: string | string[], @Req() req: Request, @Res() res: Response): Promise<void> {
    const key = Array.isArray(path) ? path.join('/') : path;
    if (!UPLOAD_KEY.test(key)) throw new ApiError('not_found', 'File not found');
    const etag = `"${key.slice(key.lastIndexOf('/') + 1)}"`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', IMMUTABLE_CACHE);
    res.setHeader('ETag', etag);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    const buf = await this.storage.get(key);
    if (!buf) {
      res.removeHeader('Cache-Control');
      res.removeHeader('ETag');
      throw new ApiError('not_found', 'File not found');
    }
    res.setHeader('Content-Type', mimeOfKey(key));
    res.setHeader('Content-Length', String(buf.length));
    res.status(200).end(buf);
  }
}
