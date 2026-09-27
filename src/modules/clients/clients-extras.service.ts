import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { normalizePhone } from '../../common/phone.js';
import {
  type ClientsBizSettings,
  type CustomFieldDef,
  getClientsBizSettings,
  patchClientsBizSettings,
} from './clients-settings.helper.js';

const CLIENT_FILE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif', 'doc', 'docx', 'pdf', 'xls', 'xlsx', 'txt'];
const CLIENT_FILE_MAX_MB = 12;
const CHAT_LEAD_TAG = 'Лид из чата';

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
  constructor(private readonly prisma: PrismaService) {}

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

  async listFiles(clientId: string) {
    const rows = await this.prisma.clientFile.findMany({ where: { clientId }, orderBy: { uploadedAt: 'desc' } });
    return rows.map((f) => ({ id: f.id, clientId: f.clientId, name: f.name, ext: f.ext, size: f.size, dataUrl: f.dataUrl, uploadedAt: f.uploadedAt.toISOString(), uploadedBy: f.uploadedBy }));
  }

  async addFile(ctx: RequestContext, clientId: string, input: { name: string; ext: string; size: number; dataUrl: string }) {
    const ext = input.ext.toLowerCase();
    if (!CLIENT_FILE_EXTENSIONS.includes(ext)) throw new ApiError('bad_ext', 'Unsupported file extension');
    if (input.size > CLIENT_FILE_MAX_MB * 1024 * 1024) throw new ApiError('too_big', `File larger than ${CLIENT_FILE_MAX_MB}MB`);
    const row = await this.prisma.clientFile.create({
      data: { id: newId('clientFile'), clientId, name: input.name, ext, size: input.size, dataUrl: input.dataUrl, uploadedBy: ctx.member!.name },
    });
    return { id: row.id, clientId: row.clientId, name: row.name, ext: row.ext, size: row.size, dataUrl: row.dataUrl, uploadedAt: row.uploadedAt.toISOString(), uploadedBy: row.uploadedBy };
  }

  async deleteFile(clientId: string, fileId: string): Promise<void> {
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

  async submitConsentForm(clientId: string, input: { name?: string; birthday?: string; adConsentGiven: boolean }) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const data: Prisma.ClientUpdateInput = {};
    if (input.name?.trim()) data.name = input.name.trim();
    if (input.birthday) data.birthday = input.birthday;
    data.adConsent = { given: input.adConsentGiven, at: new Date().toISOString(), method: 'link' } as Prisma.InputJsonValue;
    const updated = await this.prisma.client.update({ where: { id: clientId }, data });
    return updated;
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
