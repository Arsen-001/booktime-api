var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { normalizePhone } from '../../common/phone.js';
import { getClientsBizSettings, patchClientsBizSettings, } from './clients-settings.helper.js';
const CLIENT_FILE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif', 'doc', 'docx', 'pdf', 'xls', 'xlsx', 'txt'];
const CLIENT_FILE_MAX_MB = 12;
const CHAT_LEAD_TAG = 'Лид из чата';
/** F-04-145: «ключ-значение для API» — латиница/цифры/подчёркивание из подписи, с числовым суффиксом при повторе */
const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function slugifyApiKey(label, taken) {
    const base = label
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
let ClientsExtrasService = class ClientsExtrasService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    // ─────────── комментарии (F-04-070) ───────────
    async listComments(clientId) {
        const rows = await this.prisma.clientComment.findMany({ where: { clientId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
        return rows.map((c) => ({ id: c.id, clientId: c.clientId, authorId: c.authorId ?? undefined, authorName: c.authorName, text: c.text, createdAt: c.createdAt.toISOString() }));
    }
    async addComment(ctx, clientId, text) {
        const trimmed = text.trim();
        if (!trimmed)
            throw new ApiError('empty_comment', 'Comment is empty');
        const row = await this.prisma.clientComment.create({
            data: { id: newId('clientComment'), clientId, authorId: ctx.member.staffId, authorName: ctx.member.name, text: trimmed },
        });
        return { id: row.id, clientId: row.clientId, authorId: row.authorId ?? undefined, authorName: row.authorName, text: row.text, createdAt: row.createdAt.toISOString() };
    }
    async deleteComment(clientId, commentId) {
        await this.prisma.clientComment.updateMany({ where: { id: commentId, clientId }, data: { deletedAt: new Date() } });
    }
    // ─────────── файлы (F-04-086) ───────────
    async listFiles(clientId) {
        const rows = await this.prisma.clientFile.findMany({ where: { clientId }, orderBy: { uploadedAt: 'desc' } });
        return rows.map((f) => ({ id: f.id, clientId: f.clientId, name: f.name, ext: f.ext, size: f.size, dataUrl: f.dataUrl, uploadedAt: f.uploadedAt.toISOString(), uploadedBy: f.uploadedBy }));
    }
    async addFile(ctx, clientId, input) {
        const ext = input.ext.toLowerCase();
        if (!CLIENT_FILE_EXTENSIONS.includes(ext))
            throw new ApiError('bad_ext', 'Unsupported file extension');
        if (input.size > CLIENT_FILE_MAX_MB * 1024 * 1024)
            throw new ApiError('too_big', `File larger than ${CLIENT_FILE_MAX_MB}MB`);
        const row = await this.prisma.clientFile.create({
            data: { id: newId('clientFile'), clientId, name: input.name, ext, size: input.size, dataUrl: input.dataUrl, uploadedBy: ctx.member.name },
        });
        return { id: row.id, clientId: row.clientId, name: row.name, ext: row.ext, size: row.size, dataUrl: row.dataUrl, uploadedAt: row.uploadedAt.toISOString(), uploadedBy: row.uploadedBy };
    }
    async deleteFile(clientId, fileId) {
        await this.prisma.clientFile.deleteMany({ where: { id: fileId, clientId } });
    }
    // ─────────── приложение клиента (F-04-072, F-00-130) ───────────
    /**
     * «Есть ли приложение» — на лету, сравнением номеров (P1: бизнес не узнаёт ничего сверх да/нет и последнего
     * захода). Платформа устройства сервер сейчас нигде не пишет (LoginEvent.device — свободная строка UA, не
     * структурированное поле) — эвристика по подстроке, честно помечена в комментарии, а не выдана за точный факт.
     */
    async getAppActivity(phone) {
        const user = await this.prisma.user.findUnique({ where: { phone }, include: { appProfile: true } });
        if (!user?.appProfile)
            return null;
        const lastLogin = await this.prisma.loginEvent.findFirst({ where: { userId: user.id, app: 'client', result: 'ok' }, orderBy: { at: 'desc' } });
        const device = lastLogin?.device ?? '';
        const platform = /iphone|ipad|ios/i.test(device) ? 'ios' : 'android';
        return { platform, lastUsedAt: (lastLogin?.at ?? user.createdAt).toISOString() };
    }
    async getInvitedAt(businessId, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
        return client?.invitedAt ? client.invitedAt.toISOString() : null;
    }
    async inviteToApp(businessId, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        if (client.appUserId)
            throw new ApiError('already_has_app', 'Client already has the app');
        const at = new Date();
        await this.prisma.client.update({ where: { id: clientId }, data: { invitedAt: at } });
        return at.toISOString();
    }
    // ─────────── согласие на рекламу / анкета по ссылке (F-04-153/154/227) ───────────
    async recordAdConsent(businessId, clientId, given, method, recordedBy) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        const consent = { given, at: new Date().toISOString(), method, recordedBy };
        await this.prisma.client.update({ where: { id: clientId }, data: { adConsent: consent } });
        return consent;
    }
    async submitConsentForm(clientId, input) {
        const client = await this.prisma.client.findUnique({ where: { id: clientId } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        const data = {};
        if (input.name?.trim())
            data.name = input.name.trim();
        if (input.birthday)
            data.birthday = input.birthday;
        data.adConsent = { given: input.adConsentGiven, at: new Date().toISOString(), method: 'link' };
        const updated = await this.prisma.client.update({ where: { id: clientId }, data });
        return updated;
    }
    // ─────────── доп. поля (F-04-060, 139…145) ───────────
    async listCustomFieldDefs(businessId) {
        return (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
    }
    async addCustomFieldDef(businessId, input) {
        const trimmed = input.label.trim();
        if (!trimmed)
            throw new ApiError('empty_label', 'Field label required');
        const type = input.type ?? 'text';
        const options = type === 'list' ? (input.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined;
        if (type === 'list' && (!options || options.length < 2))
            throw new ApiError('list_needs_options', 'Add at least two list options');
        const existing = (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
        const def = {
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
    async deleteCustomFieldDef(businessId, fieldId) {
        const existing = (await getClientsBizSettings(this.prisma, businessId)).customFieldDefs;
        if (!existing.some((d) => d.id === fieldId))
            throw new ApiError('not_found', 'Field already removed');
        await patchClientsBizSettings(this.prisma, businessId, { customFieldDefs: existing.filter((d) => d.id !== fieldId) });
        // Осиротевшие значения на клиентах чистить не обязательно (клиент их просто больше не покажет по apiKey);
        // делаем это лениво не будем — таблицы client_field_values нет (JSON на строке, см. схему)
    }
    // ─────────── настройки базы (arch-a1 №2) ───────────
    async getSettings(businessId) {
        return getClientsBizSettings(this.prisma, businessId);
    }
    async setShowFullNameFields(businessId, value) {
        return (await patchClientsBizSettings(this.prisma, businessId, { showFullNameFields: value })).showFullNameFields;
    }
    async setShowLoyaltySearchInBookingWindow(businessId, value) {
        return (await patchClientsBizSettings(this.prisma, businessId, { showLoyaltySearchInBookingWindow: value })).showLoyaltySearchInBookingWindow;
    }
    async setAutoSaveChatLeads(businessId, value) {
        return (await patchClientsBizSettings(this.prisma, businessId, { autoSaveChatLeads: value })).autoSaveChatLeads;
    }
    async setLostAfterDays(businessId, days) {
        if (!Number.isFinite(days) || days < 7 || days > 365)
            throw new ApiError('invalid_days', 'Between 7 and 365 days');
        return (await patchClientsBizSettings(this.prisma, businessId, { lostAfterDays: Math.round(days) })).lostAfterDays;
    }
    /** Что делает хук чата, когда кто-то впервые напишет (F-04-016 «Готово, когда») — демонстрационная кнопка */
    async simulateChatLead(ctx, businessId) {
        const settings = await getClientsBizSettings(this.prisma, businessId);
        if (!settings.autoSaveChatLeads)
            throw new ApiError('chat_autosave_off', 'Chat auto-save is off');
        const id = newId('client');
        const phone = normalizePhone(`0${Math.floor(1_000_000 + Math.random() * 8_000_000)}`) ?? '+37400000000';
        return this.prisma.client.create({
            data: { id, businessId, phone, name: 'No name', gender: 'unknown', tags: [CHAT_LEAD_TAG], source: 'chat', createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId },
        });
    }
    // ─────────── тонкие права «Клиентская база» (F-04-194…204) ───────────
    async getFineRights(staffId) {
        const row = await this.prisma.clientFineRights.findUnique({ where: { staffId } });
        return row?.rights ?? undefined;
    }
    async setFineRights(businessId, staffId, rights) {
        await this.prisma.clientFineRights.upsert({
            where: { staffId },
            create: { staffId, businessId, rights: rights },
            update: { rights: rights },
        });
        return rights;
    }
    // ─────────── колонки таблицы (F-04-004/005) ───────────
    async getColumnsPrefs(businessId, staffId) {
        const row = await this.prisma.clientColumnsPref.findUnique({ where: { businessId_staffId: { businessId, staffId: staffId ?? '' } } });
        return { visible: row?.visible ?? DEFAULT_VISIBLE, pinned: row?.pinned ?? [] };
    }
    async setVisibleColumns(businessId, staffId, visible) {
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
    async togglePinnedColumn(businessId, staffId, id) {
        const current = await this.getColumnsPrefs(businessId, staffId);
        if (!current.pinned.includes(id) && current.pinned.length >= 5)
            throw new ApiError('pin_limit', 'Cannot pin more than 5 columns');
        const pinned = current.pinned.includes(id) ? current.pinned.filter((x) => x !== id) : [...current.pinned, id];
        await this.prisma.clientColumnsPref.upsert({
            where: { businessId_staffId: { businessId, staffId: staffId ?? '' } },
            create: { businessId, staffId: staffId ?? '', visible: current.visible, pinned },
            update: { pinned },
        });
        return { visible: current.visible, pinned };
    }
};
ClientsExtrasService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ClientsExtrasService);
export { ClientsExtrasService };
const CLIENT_COLUMN_IDS = ['name', 'phone', 'email', 'sold', 'balance', 'visits', 'discount', 'lastVisit', 'firstVisit'];
const DEFAULT_VISIBLE = CLIENT_COLUMN_IDS.filter((id) => id !== 'email' && id !== 'firstVisit');
//# sourceMappingURL=clients-extras.service.js.map