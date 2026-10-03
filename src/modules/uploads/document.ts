import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from './image.js';

/**
 * Документы клиентов (04.10.2026, «Файлы и фото»): карта клиента хранит PDF, фото, документы Office и текст.
 * Тип — только по первым байтам файла (расширению и Content-Type не верим), файл кладётся как есть, без
 * перекодирования, в ЗАКРЫТОЕ хранилище (createFileStorage: бакет под private/ или диск STORAGE_DIR) — наружу не
 * раздаётся, только через GET /v1/biz/:businessId/clients/:id/files/:fileId/content с правом clients.view.
 */
export const MAX_DOCUMENT_BYTES = MAX_UPLOAD_BYTES;

export type DocumentKind = 'pdf' | 'jpg' | 'png' | 'gif' | 'webp' | 'docx' | 'xlsx' | 'doc' | 'xls' | 'txt';

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain; charset=utf-8',
};

/** Расширения, которые экран разрешает выбрать (domain/clients CLIENT_FILE_EXTENSIONS) → тип по сигнатуре */
const EXT_KIND: Record<string, DocumentKind> = {
  pdf: 'pdf',
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  docx: 'docx',
  xlsx: 'xlsx',
  doc: 'doc',
  xls: 'xls',
  txt: 'txt',
};

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Тип документа по сигнатуре. ext — расширение из имени: нужно, только чтобы различить docx/xlsx (оба ZIP) и
 * doc/xls (оба OLE) — сама сигнатура всё равно обязана совпасть. Не узнали — null.
 */
export function sniffDocument(buf: Buffer, ext: string): DocumentKind | null {
  if (buf.length < 4) return null;
  const want = EXT_KIND[ext.toLowerCase()];
  if (buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // Office Open XML — ZIP с [Content_Types].xml и папкой word/ или xl/
  if (buf.subarray(0, 4).equals(ZIP) && (want === 'docx' || want === 'xlsx')) {
    const s = buf.toString('latin1');
    if (!s.includes('[Content_Types].xml')) return null;
    if (want === 'docx' && s.includes('word/')) return 'docx';
    if (want === 'xlsx' && s.includes('xl/')) return 'xlsx';
    return null;
  }
  // Старый Office (Compound File Binary)
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE) && (want === 'doc' || want === 'xls')) return want;
  // Текст: только с расширением .txt, без нулевых байт и с правильным UTF-8
  if (want === 'txt' && !buf.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return 'txt';
    } catch {
      return null;
    }
  }
  return null;
}

export class DocumentError extends Error {
  constructor(
    readonly reason: 'too_large' | 'unsupported' | 'empty',
    message: string,
  ) {
    super(message);
  }
}

export interface CheckedDocument {
  kind: DocumentKind;
  mime: string;
  /** 32 hex sha256 содержимого — часть ключа */
  hash: string;
  bytes: number;
}

export function checkDocument(buf: Buffer, ext: string): CheckedDocument {
  if (!buf.length) throw new DocumentError('empty', 'File is empty');
  if (buf.length > MAX_DOCUMENT_BYTES) throw new DocumentError('too_large', `File is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  const kind = sniffDocument(buf, ext);
  if (!kind) throw new DocumentError('unsupported', 'Not a PDF, image (JPEG/PNG/GIF/WebP), Word/Excel document or UTF-8 text');
  return { kind, mime: DOCUMENT_MIME[kind], hash: createHash('sha256').update(buf).digest('hex').slice(0, 32), bytes: buf.length };
}

/** Ключ документа клиента в закрытом хранилище: client-files/<бизнес>/<hash>.<ext> */
export const CLIENT_FILE_KEY = /^client-files\/[A-Za-z0-9_-]{1,40}\/[0-9a-f]{32}\.(?:pdf|jpg|png|gif|webp|docx|xlsx|doc|xls|txt)$/;

export function clientFileKey(businessId: string, doc: Pick<CheckedDocument, 'hash' | 'kind'>): string {
  const owner = businessId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'x';
  return `client-files/${owner}/${doc.hash}.${doc.kind}`;
}

/** Тип для ответа по ключу (раздача) */
export function documentMimeOfKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1) as DocumentKind;
  return DOCUMENT_MIME[ext] ?? 'application/octet-stream';
}

/** Content-Disposition: attachment с именем файла (ASCII-запасное + filename* UTF-8, RFC 6266/5987) */
export function attachmentDisposition(name: string): string {
  const clean = name.replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
