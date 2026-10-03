import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { normalizePhone } from '../../common/phone.js';
import { env } from '../../common/config/env.js';
import type { ClientFile } from '../../generated/prisma/client.js';
import { UploadsService } from '../uploads/uploads.service.js';
import {
  type ClientsBizSettings,
  type CustomFieldDef,
  getClientsBizSettings,
  patchClientsBizSettings,
} from './clients-settings.helper.js';

const CLIENT_FILE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif', 'doc', 'docx', 'pdf', 'xls', 'xlsx', 'txt'];
const CLIENT_FILE_MAX_MB = 12;
/** Загрузка файлом (04.10.2026): как у фото — до 10 МБ; JSON с data: URL (мок, старые сборки) — по-прежнему до 12 МБ */
export const CLIENT_FILE_UPLOAD_MAX_MB = 10;
const CHAT_LEAD_TAG = 'Лид из чата';
/** Имя файла из multipart: busboy читает его как latin1 — UTF-8 (кириллица) восстанавливаем, если байты сходятся */
function multipartName(raw: string | undefined): string {
  const v = raw?.trim() ?? '';
  if (!v || /[^\x00-\xff]/.test(v)) return v;
  const utf8 = Buffer.from(v, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? v : utf8;
}

/** Типы старых data: URL, которые можно отдать как есть (скачивание всё равно attachment + nosniff) */
const SAFE_LEGACY_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** F-04-145: «ключ-значение для API» — латиница/цифры/подчёркивание из подписи, с числовым суффиксом при повторе */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function slugifyApiKey(label: string, taken: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .split('')
      .map((ch) => TRANSLIT[ch] ?? ch)
      .join('')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field';
  let key = base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  return key;
}

@Injectable()
export class ClientsExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  // ─────────── комментарии (F-04-070) ───────────

  async listComments(clientId: string) {
    const rows = await this.prisma.clientComment.findMany({ where: { clientId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map((c) => ({ id: c.id, clientId: c.clientId, authorId: c.authorId ?? undefined, authorName: c.authorName, text: c.text, createdAt: c.createdAt.toISOString() }));
  }

  async addComment(ctx: RequestContext, clientId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError('empty_comment', 'Comment is empty');
    const row = await this.prisma.clientComment.create({
      data: { id: newId('clientComment'), clientId, authorId: ctx.member!.staffId, authorName: ctx.member!.name, text: trimmed },
    });
    return { id: row.id, clientId: row.clientId, authorId: row.authorId ?? undefined, authorName: row.authorName, text: row.text, createdAt: row.createdAt.toISOString() };
  }

  async deleteComment(clientId: string, commentId: string): Promise<void> {
    await this.prisma.clientComment.updateMany({ where: { id: commentId, clientId }, data: { deletedAt: new Date() } });
  }

  // ─────────── файлы (F-04-086) ───────────

  /** Клиент этого бизнеса — иначе 404 (id клиента из чужого бизнеса не открывает его файлы) */
  private async assertClient(businessId: string, clientId: string): Promise<void> {
    const c = await this.prisma.client.findFirst({ where: { id: clientId, businessId }, select: { id: true } });
    if (!c) throw new ApiError('not_found', 'Client not found');
  }

  /**
   * Файл в ответе. contentUrl — скачивание через кабинет (права clients.view, Content-Disposition: attachment) для
   * любой строки. dataUrl — старые строки: data: URL как был; файлы в хранилище (04.10.2026) — тот же contentUrl,
   * чтобы прежние сборки сайта (href / src = dataUrl) продолжали работать.
   */
  private fileView(businessId: string, f: ClientFile, requestBase: string) {
    const base = (env.PUBLIC_API_URL || requestBase).replace(/\/+$/, '');
    const contentUrl = `${base}/v1/biz/${encodeURIComponent(businessId)}/clients/${encodeURIComponent(f.clientId)}/files/${encodeURIComponent(f.id)}/content`;
    return {
      id: f.id,
      clientId: f.clientId,
      name: f.name,
      ext: f.ext,
      size: f.size,
      dataUrl: f.storageKey ? contentUrl : (f.dataUrl ?? ''),
      contentUrl,
      stored: Boolean(f.storageKey),
      mime: f.mime,
      uploadedAt: f.uploadedAt.toISOString(),
      uploadedBy: f.uploadedBy,
    };
  }

  async listFiles(businessId: string, clientId: string, requestBase: string) {
    await this.assertClient(businessId, clientId);
    const rows = await this.prisma.clientFile.findMany({ where: { clientId }, orderBy: { uploadedAt: 'desc' } });
    return rows.map((f) => this.fileView(businessId, f, requestBase));
  }

  /** Старый путь (мок-совместимый JSON с data: URL) — для прежних сборок; новый сайт шлёт файл uploadFile */
  async addFile(ctx: RequestContext, businessId: string, clientId: string, input: { name: string; ext: string; size: number; dataUrl: string }, requestBase: string) {
    await this.assertClient(businessId, clientId);
    const ext = input.ext.toLowerCase();
    if (!CLIENT_FILE_EXTENSIONS.includes(ext)) throw new ApiError('bad_ext', 'Unsupported file extension');
    if (input.size > CLIENT_FILE_MAX_MB * 1024 * 1024) throw new ApiError('too_big', `File larger than ${CLIENT_FILE_MAX_MB}MB`);
    const row = await this.prisma.clientFile.create({
      data: { id: newId('clientFile'), clientId, name: input.name, ext, size: input.size, dataUrl: input.dataUrl, uploadedBy: ctx.member!.name },
    });
    return this.fileView(businessId, row, requestBase);
  }

  /**
   * Документ файлом (04.10.2026): multipart → тип по сигнатуре (PDF, фото, Word/Excel, текст) → закрытое хранилище
   * как есть (UploadsService.storeDocument) → строка client_files со storage_key. Расширение — из имени файла.
   */
  async uploadFile(ctx: RequestContext, businessId: string, clientId: string, file: { buffer: Buffer; originalname?: string } | undefined, nameField: string | undefined, requestBase: string) {
    await this.assertClient(businessId, clientId);
    const name = (nameField?.trim() || multipartName(file?.originalname) || 'file').slice(0, 200);
    const ext = (name.includes('.') ? name.split('.').pop()! : '').toLowerCase();
    if (!CLIENT_FILE_EXTENSIONS.includes(ext)) throw new ApiError('bad_ext', 'Unsupported file extension');
    const stored = await this.uploads.storeDocument({ businessId, by: ctx.member!.staffId }, file, ext);
    const row = await this.prisma.clientFile.create({
      data: { id: newId('clientFile'), clientId, name, ext, size: stored.bytes, dataUrl: null, storageKey: stored.key, mime: stored.mime, uploadedBy: ctx.member!.name },
    });
    return this.fileView(businessId, row, requestBase);
  }

  /**
   * Содержимое документа для скачивания: файл из закрытого хранилища или (старые строки) раскодированный data: URL.
   * Тип — сохранённый по сигнатуре; у старых строк — из data: URL, но только из списка безопасных, иначе octet-stream.
   */
  async fileContent(businessId: string, clientId: string, fileId: string): Promise<{ body: Buffer; mime: string; name: string }> {
    await this.assertClient(businessId, clientId);
    const f = await this.prisma.clientFile.findFirst({ where: { id: fileId, clientId } });
    if (!f) throw new ApiError('not_found', 'File not found');
    if (f.storageKey) {
      const body = await this.uploads.readDocument(f.storageKey);
      if (!body) throw new ApiError('not_found', 'File not found');
      return { body, mime: f.mime ?? 'application/octet-stream', name: f.name };
    }
    const m = /^data:([\w.+/-]*)(?:;[\w=.+-]+)*?(;base64)?,/.exec(f.dataUrl ?? '');
    if (!m) throw new ApiError('not_found', 'File not found');
    const raw = f.dataUrl!.slice(m[0].length);
    const body = m[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8');
    return { body, mime: SAFE_LEGACY_MIME.has(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : 'application/octet-stream', name: f.name };
  }

  async deleteFile(businessId: string, clientId: string, fileId: string): Promise<void> {
    await this.assertClient(businessId, clientId);
    // Файл в хранилище остаётся до ночной уборки (jobs/uploads-cleanup.ts: 7 дней без ссылок) — отмена и повтор безопасны
    await this.prisma.clientFile.deleteMany({ where: { id: fileId, clientId } });
  }

  // ─────────── приложение клиента (F-04-072, F-00-130) ───────────

  /**
   * «Есть ли приложение» — на лету, сравнением номеров (P1: бизнес не узнаёт ничего сверх да/нет и последнего
   * захода). Платформа устройства сервер сейчас нигде не пишет (LoginEvent.device — свободная строка UA, не
   * структурированное поле) — эвристика по подстроке, честно помечена в комментарии, а не выдана за точный факт.
   */
  async getAppActivity(phone: string) {
    const user = await this.prisma.user.findUnique({ where: { phone }, include: { appProfile: true } });
    if (!user?.appProfile) return null;
    const lastLogin = await this.prisma.loginEvent.findFirst({ where: { userId: user.id, app: 'client', result: 'ok' }, orderBy: { at: 'desc' } });
    const device = lastLogin?.device ?? '';
    const platform: 'ios' | 'android' = /iphone|ipad|ios/i.test(device) ? 'ios' : 'android';
    return { platform, lastUsedAt: (lastLogin?.at ?? user.createdAt).toISOString() };
  }

  async getInvitedAt(businessId: string, clientId: string): Promise<string | null> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
    return client?.invitedAt ? client.invitedAt.toISOString() : null;
  }

  async inviteToApp(businessId: string, clientId: string): Promise<string> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    if (client.appUserId) throw new ApiError('already_has_app', 'Client already has the app');
    const at = new Date();
    await this.prisma.client.update({ where: { id: clientId }, data: { invitedAt: at } });
    return at.toISOString();
  }

  // ─────────── согласие на рекламу / анкета по ссылке (F-04-153/154/227) ───────────

  async recordAdConsent(businessId: string, clientId: string, given: boolean, method: string, recordedBy?: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const consent = { given, at: new Date().toISOString(), method, recordedBy };
    await this.prisma.client.update({ where: { id: clientId }, data: { adConsent: consent as Prisma.InputJsonValue } });
    return consent;
  }

  /** Анкета под сессией бизнеса (этап 21): клиент обязан принадлежать бизнесу из пути */
  async submitConsentFormFor(businessId: string, clientId: string, input: { name?: string; birthday?: string; adConsentGiven: boolean }) {
    const own = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null }, select: { id: true } });
    if (!own) throw new ApiError('not_found', 'Client not found');
    return this.submitConsentForm(clientId, input);
  }

  async submitConsentForm(clientId: string, input: { name?: string; birthday?: string; adConsentGiven: boolean }) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const data: Prisma.ClientUpdateInput = {};
    if (input.name?.trim()) data.name = input.name.trim();
    if (input.birthday) data.birthday = input.birthday;
    data.adConsent = { given: input.adConsentGiven, at: new Date().toISOString(), method: 'link' } as Prisma.InputJsonValue;
    const updated = await this.prisma.client.update({ where: { id: clientId }, data });
    // Только поля ядра (domain/core.ts::Client) — тот же набор, что `toClient()` в src/api/clients/card.ts,
    // экран анкеты (`ConsentFormScreen`) не знает про ClientRow-агрегаты (visits/sold/…)
    return {
      id: updated.id,
      businessId: updated.businessId,
      phone: updated.phone,
      name: updated.name,
      gender: updated.gender as 'female' | 'male' | 'unknown',
      birthday: updated.birthday ?? undefined,
      email: updated.email ?? undefined,
      note: updated.note ?? undefined,
      tags: (updated.tags as string[] | null) ?? [],
      appUserId: updated.appUserId ?? undefined,
      noShowCount: updated.noShowCount,
      blocked: updated.blocked ?? undefined,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  // ─────────── визиты, лояльность клиента, напоминание (F-04-091/093/099/100, этап 21, лейн rest, попытка 2) ───────────

  /**
   * F-04-091: люди, записанные на номер этого клиента (ребёнок/питомец/другое, F-00-125). Считаем по ВСЕМ
   * записям, включая мягко удалённые (deletedAt) — карточка не теряет посетителя, когда все записи удалены
   * (проверено на Altegio: «Посетители: …» остаётся); визит засчитан только если статус arrived и запись жива.
   */
  async listVisitors(businessId: string, clientId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { businessId, clientId, forWhom: { not: 'self' }, visitorName: { not: null } },
      select: { forWhom: true, visitorName: true, status: true, deletedAt: true, startAt: true },
      orderBy: { startAt: 'asc' },
    });
    const map = new Map<string, { key: string; name: string; forWhom: string; visits: number; lastVisit?: string }>();
    for (const b of bookings) {
      const name = (b.visitorName ?? '').trim();
      if (!name) continue;
      const key = `${b.forWhom}:${name}`;
      const row = map.get(key) ?? { key, name, forWhom: b.forWhom, visits: 0, lastVisit: undefined };
      if (!b.deletedAt && b.status === 'arrived') row.visits += 1;
      if (!b.deletedAt) {
        const d = b.startAt.toISOString().slice(0, 10);
        if (!row.lastVisit || d > row.lastVisit) row.lastVisit = d;
      }
      map.set(key, row);
    }
    return Array.from(map.values());
  }

  /**
   * F-04-093: лояльность одного клиента для мини-карточки в окне записи — сертификаты и абонементы с
   * балансами. Читает уже готовые таблицы раздела loyalty (`Certificate`/`MembershipSale`, этап 11/21) сама
   * (запрос на чтение, без правки чужой схемы) — не завожу параллельный сервис в модуле loyalty, которым
   * сейчас занят другой лейн.
   */
  async getClientLoyalty(businessId: string, clientId: string) {
    const [certs, subs] = await Promise.all([
      this.prisma.certificate.findMany({ where: { businessId, clientId }, include: { type: true }, orderBy: { soldAt: 'desc' } }),
      this.prisma.membershipSale.findMany({ where: { businessId, clientId }, include: { type: true }, orderBy: { soldAt: 'desc' } }),
    ]);
    return {
      certificates: certs.map((c) => ({
        id: c.id,
        businessId: c.businessId,
        clientId: c.clientId as string,
        name: c.type.name,
        total: Number(c.total),
        balance: Number(c.balance),
        soldAt: c.soldAt.toISOString().slice(0, 10),
        expiresAt: c.expiresAt.toISOString().slice(0, 10),
        code: c.code,
      })),
      subscriptions: subs.map((s) => ({
        id: s.id,
        businessId: s.businessId,
        clientId: s.clientId as string,
        name: s.type.name,
        status: (s.status === 'active' ? 'active' : 'expired') as 'active' | 'expired',
        frozen: s.status === 'frozen',
        soldAt: s.soldAt.toISOString().slice(0, 10),
        expiresAt: s.expiresAt.toISOString().slice(0, 10),
        totalVisits: s.totalVisits ?? 0,
        remainingVisits: s.remainingVisits ?? 0,
        code: s.code,
      })),
    };
  }

  /** F-04-099: клиент по номеру абонемента/сертификата (showLoyaltySearchInBookingWindow) */
  async findClientByLoyaltyCode(businessId: string, code: string): Promise<{ clientId: string; clientName: string } | undefined> {
    const trimmed = code.trim();
    if (!trimmed) return undefined;
    const [sub, cert] = await Promise.all([
      this.prisma.membershipSale.findFirst({ where: { businessId, code: trimmed } }),
      this.prisma.certificate.findFirst({ where: { businessId, code: trimmed } }),
    ]);
    const clientId = sub?.clientId ?? cert?.clientId;
    if (!clientId) return undefined;
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null } });
    if (!client) return undefined;
    return { clientId, clientName: client.name };
  }

  /** F-04-100: своё напоминание/приглашение на повтор поверх одной записи */
  async getBookingReminder(bookingId: string) {
    const row = await this.prisma.bookingReminder.findUnique({ where: { bookingId } });
    if (!row) return undefined;
    return { bookingId: row.bookingId, remindAt: row.remindAt?.toISOString(), revisitInviteDays: row.revisitInviteDays ?? undefined };
  }

  async setBookingReminder(bookingId: string, patch: { remindAt?: string; revisitInviteDays?: number }) {
    if (patch.revisitInviteDays !== undefined && (patch.revisitInviteDays < 0 || patch.revisitInviteDays > 365)) {
      throw new ApiError('invalid_days', 'Between 0 and 365 days');
    }
    const row = await this.prisma.bookingReminder.upsert({
      where: { bookingId },
      create: { bookingId, remindAt: patch.remindAt ? new Date(patch.remindAt) : undefined, revisitInviteDays: patch.revisitInviteDays },
      update: { ...(patch.remindAt !== undefined ? { remindAt: patch.remindAt ? new Date(patch.remindAt) : null } : {}), ...(patch.revisitInviteDays !== undefined ? { revisitInviteDays: patch.revisitInviteDays } : {}) },
    });
    return { bookingId: row.bookingId, remindAt: row.remindAt?.toISOString(), revisitInviteDays: row.revisitInviteDays ?? undefined };
  }

  // ─────────── доп. поля (F-04-060, 139…145) ───────────

  async listCustomFieldDefs(businessId: string): Promise<CustomFieldDef[]> {
    return (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
  }

  async addCustomFieldDef(
    businessId: string,
    input: { label: string; type?: CustomFieldDef['type']; options?: string[]; required?: boolean; editableByClient?: boolean; alwaysShowInClientCard?: boolean; alwaysShowInBookingWindow?: boolean },
  ): Promise<CustomFieldDef> {
    const trimmed = input.label.trim();
    if (!trimmed) throw new ApiError('empty_label', 'Field label required');
    const type = input.type ?? 'text';
    const options = type === 'list' ? (input.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined;
    if (type === 'list' && (!options || options.length < 2)) throw new ApiError('list_needs_options', 'Add at least two list options');
    const existing = (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
    const def: CustomFieldDef = {
      id: newId('clientCustomField'),
      label: trimmed,
      type,
      options,
      required: input.required ?? false,
      apiKey: slugifyApiKey(trimmed, new Set(existing.map((d) => d.apiKey))),
      editableByClient: input.editableByClient ?? false,
      alwaysShowInClientCard: input.alwaysShowInClientCard ?? false,
      alwaysShowInBookingWindow: input.alwaysShowInBookingWindow ?? false,
    };
    await patchClientsBizSettings(this.prisma, businessId, { customFieldDefs: [...existing, def] });
    return def;
  }

  async deleteCustomFieldDef(businessId: string, fieldId: string): Promise<void> {
    const existing = (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
    if (!existing.some((d) => d.id === fieldId)) throw new ApiError('not_found', 'Field already removed');
    await patchClientsBizSettings(this.prisma, businessId, { customFieldDefs: existing.filter((d) => d.id !== fieldId) });
    // Осиротевшие значения на клиентах чистить не обязательно (клиент их просто больше не покажет по apiKey);
    // делаем это лениво не будем — таблицы client_field_values нет (JSON на строке, см. схему)
  }

  // ─────────── настройки базы (arch-a1 №2) ───────────

  async getSettings(businessId: string): Promise<ClientsBizSettings> {
    return getClientsBizSettings(this.prisma, businessId);
  }

  async setShowFullNameFields(businessId: string, value: boolean): Promise<boolean> {
    return (await patchClientsBizSettings(this.prisma, businessId, { showFullNameFields: value })).showFullNameFields;
  }

  async setShowLoyaltySearchInBookingWindow(businessId: string, value: boolean): Promise<boolean> {
    return (await patchClientsBizSettings(this.prisma, businessId, { showLoyaltySearchInBookingWindow: value })).showLoyaltySearchInBookingWindow;
  }

  async setAutoSaveChatLeads(businessId: string, value: boolean): Promise<boolean> {
    return (await patchClientsBizSettings(this.prisma, businessId, { autoSaveChatLeads: value })).autoSaveChatLeads;
  }

  async setLostAfterDays(businessId: string, days: number): Promise<number> {
    if (!Number.isFinite(days) || days < 7 || days > 365) throw new ApiError('invalid_days', 'Between 7 and 365 days');
    return (await patchClientsBizSettings(this.prisma, businessId, { lostAfterDays: Math.round(days) })).lostAfterDays;
  }

  /** «⋯ Ещё» в окне записи (F-04-093, этап 21 «Сдача»): закрепить/открепить плитку — общий для всех, кто видит клиентов */
  async toggleBookingWindowFavorite(businessId: string, section: ClientsBizSettings['bookingWindowFavorites'][number]): Promise<ClientsBizSettings['bookingWindowFavorites']> {
    const current = await getClientsBizSettings(this.prisma, businessId);
    const next = current.bookingWindowFavorites.includes(section) ? current.bookingWindowFavorites.filter((s) => s !== section) : [...current.bookingWindowFavorites, section];
    return (await patchClientsBizSettings(this.prisma, businessId, { bookingWindowFavorites: next })).bookingWindowFavorites;
  }

  /** Что делает хук чата, когда кто-то впервые напишет (F-04-016 «Готово, когда») — демонстрационная кнопка */
  async simulateChatLead(ctx: RequestContext, businessId: string) {
    const settings = await getClientsBizSettings(this.prisma, businessId);
    if (!settings.autoSaveChatLeads) throw new ApiError('chat_autosave_off', 'Chat auto-save is off');
    const id = newId('client');
    const phone = normalizePhone(`0${Math.floor(1_000_000 + Math.random() * 8_000_000)}`) ?? '+37400000000';
    return this.prisma.client.create({
      data: { id, businessId, phone, name: 'No name', gender: 'unknown', tags: [CHAT_LEAD_TAG], source: 'chat', createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
    });
  }

  // ─────────── тонкие права «Клиентская база» (F-04-194…204) ───────────

  async getFineRights(staffId: string): Promise<Record<string, boolean> | undefined> {
    const row = await this.prisma.clientFineRights.findUnique({ where: { staffId } });
    return (row?.rights as Record<string, boolean> | undefined) ?? undefined;
  }

  async setFineRights(businessId: string, staffId: string, rights: Record<string, boolean>): Promise<Record<string, boolean>> {
    await this.prisma.clientFineRights.upsert({
      where: { staffId },
      create: { staffId, businessId, rights: rights as Prisma.InputJsonValue },
      update: { rights: rights as Prisma.InputJsonValue },
    });
    return rights;
  }

  // ─────────── колонки таблицы (F-04-004/005) ───────────

  async getColumnsPrefs(businessId: string, staffId: string | undefined) {
    const row = await this.prisma.clientColumnsPref.findUnique({ where: { businessId_staffId: { businessId, staffId: staffId ?? '' } } });
    return { visible: (row?.visible as string[] | undefined) ?? DEFAULT_VISIBLE, pinned: (row?.pinned as string[] | undefined) ?? [] };
  }

  async setVisibleColumns(businessId: string, staffId: string | undefined, visible: string[]) {
    const filtered = CLIENT_COLUMN_IDS.filter((id) => id === 'name' || visible.includes(id));
    const current = await this.getColumnsPrefs(businessId, staffId);
    const pinned = current.pinned.filter((id) => filtered.includes(id));
    await this.prisma.clientColumnsPref.upsert({
      where: { businessId_staffId: { businessId, staffId: staffId ?? '' } },
      create: { businessId, staffId: staffId ?? '', visible: filtered, pinned },
      update: { visible: filtered, pinned },
    });
    return { visible: filtered, pinned };
  }

  async togglePinnedColumn(businessId: string, staffId: string | undefined, id: string) {
    const current = await this.getColumnsPrefs(businessId, staffId);
    if (!current.pinned.includes(id) && current.pinned.length >= 5) throw new ApiError('pin_limit', 'Cannot pin more than 5 columns');
    const pinned = current.pinned.includes(id) ? current.pinned.filter((x) => x !== id) : [...current.pinned, id];
    await this.prisma.clientColumnsPref.upsert({
      where: { businessId_staffId: { businessId, staffId: staffId ?? '' } },
      create: { businessId, staffId: staffId ?? '', visible: current.visible, pinned },
      update: { pinned },
    });
    return { visible: current.visible, pinned };
  }
}

const CLIENT_COLUMN_IDS = ['name', 'phone', 'email', 'sold', 'balance', 'visits', 'discount', 'lastVisit', 'firstVisit'];
const DEFAULT_VISIBLE = CLIENT_COLUMN_IDS.filter((id) => id !== 'email' && id !== 'firstVisit');
