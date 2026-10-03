import { createHash } from 'node:crypto';
import sharp, { type Metadata, type Sharp } from 'sharp';

/**
 * Фото (04.10.2026, «Файлы и фото»): тип — по первым байтам файла (заголовку Content-Type не верим), затем sharp
 * перекодирует картинку заново: поворот по EXIF, не больше 2048 px по длинной стороне, превью 512 px, без EXIF/GPS
 * и прочих метаданных (sharp не переносит их, пока не попросить withMetadata). Без прозрачности — JPEG (открывается
 * везде, включая письма и Telegram), с прозрачностью (логотипы PNG) — WebP.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_SIDE = 2048;
export const THUMB_SIDE = 512;
/** Больше стольких пикселей исходника не разбираем (защита от «бомбы распаковки») */
const MAX_INPUT_PIXELS = 50_000_000;

export type SniffedType = 'jpeg' | 'png' | 'webp' | 'gif' | 'heic';

/** Тип картинки по сигнатуре; не картинка из списка — null */
export function sniffImage(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  // ISO BMFF: ....ftyp<brand> — HEIC/HEIF с iPhone (AVIF сюда не относим)
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

export interface ProcessedImage {
  /** Хеш содержимого основного файла (32 hex) — часть ключа: тот же файл → тот же ключ, кэш навсегда */
  hash: string;
  ext: 'jpg' | 'webp';
  mime: 'image/jpeg' | 'image/webp';
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

export class ImageError extends Error {
  constructor(
    readonly reason: 'too_large' | 'unsupported' | 'broken',
    message: string,
  ) {
    super(message);
  }
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageError('too_large', `File is larger than ${MAX_UPLOAD_BYTES} bytes`);
  const type = sniffImage(input);
  if (!type) throw new ImageError('unsupported', 'Not a JPEG, PNG, WebP, GIF or HEIC image');
  const open = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    // HEIC (HEVC) сборка sharp не читает (патенты) — браузеры iPhone обычно сами присылают JPEG
    throw new ImageError(type === 'heic' ? 'unsupported' : 'broken', type === 'heic' ? 'HEIC is not supported, send JPEG' : 'Image cannot be decoded');
  }
  const alpha = Boolean(meta.hasAlpha);
  const ext = alpha ? 'webp' : 'jpg';
  const encode = (img: Sharp) =>
    alpha ? img.webp({ quality: 85, effort: 4 }) : img.flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true });
  try {
    const { data: main, info } = await encode(open().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })).toBuffer({
      resolveWithObject: true,
    });
    const thumb = await encode(open().resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true })).toBuffer();
    return {
      hash: createHash('sha256').update(main).digest('hex').slice(0, 32),
      ext,
      mime: alpha ? 'image/webp' : 'image/jpeg',
      main,
      thumb,
      width: info.width,
      height: info.height,
    };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError('broken', 'Image cannot be decoded');
  }
}

/** Ключи фото: uploads/<владелец>/<hash>.<ext> и превью uploads/<владелец>/<hash>_t.<ext> */
export const UPLOAD_KEY = /^uploads\/[A-Za-z0-9_-]{1,40}\/[0-9a-f]{32}(?:_t)?\.(?:jpg|webp)$/;

export function uploadKeys(owner: string, img: Pick<ProcessedImage, 'hash' | 'ext'>): { key: string; thumbKey: string } {
  const safeOwner = owner.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'x';
  return { key: `uploads/${safeOwner}/${img.hash}.${img.ext}`, thumbKey: `uploads/${safeOwner}/${img.hash}_t.${img.ext}` };
}

export function thumbKeyOf(key: string): string {
  return key.replace(/\.(jpg|webp)$/, '_t.$1');
}

export function mimeOfKey(key: string): string {
  return key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
}
