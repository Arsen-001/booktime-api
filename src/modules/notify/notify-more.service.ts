import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { MAIL_SENDER } from '../../adapters/adapters.js';
import type { MailSender } from '../../adapters/mail/mail.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Этап 21 «notify+integrations», попытка 3: вторая пачка «своих» настроек notify, у которых форма ответа НЕ
 * зависит от каталога типов Altegio (см. notify-misc.service.ts докстринг и docs/PROGRESS.md этап 21 — разбор,
 * почему listTypes/getStaffNotifyPrefs и т.п. остаются на моке). Каждая настройка — своя область BusinessSetting
 * (тот же приём, что NotifyMiscService), без общей схемы — только `getServiceReminderHours`/`listWebhooks` хранят
 * составные значения (map/массив) в JSON той же области.
 */

const AREA_SETTINGS = 'notify-settings';
const AREA_GIFT_SHOWCASE = 'notify-gift-showcase';
const AREA_OPEN_SLOTS_SCHEDULE = 'notify-open-slots-schedule';
const AREA_PARTNER_SUMMARY = 'notify-partner-summary';
const AREA_ALTEGIO_WHATSAPP = 'notify-altegio-whatsapp';
const AREA_AGENT_FLAGS = 'notify-agent-flags';
const AREA_SERVICE_REMINDER_HOURS = 'notify-service-reminder-hours';
const AREA_WEBHOOKS = 'notify-webhooks';

export interface NotifyQuietHoursOut {
  enabled: boolean;
  from: string;
  to: string;
}
const DEFAULT_QUIET_HOURS: NotifyQuietHoursOut = { enabled: true, from: '22:00', to: '09:00' };

export interface NotifySettingsOut {
  language: 'ru' | 'hy' | 'en';
  dateFormat: '24h' | '12h';
  quietHours: NotifyQuietHoursOut;
}
const DEFAULT_SETTINGS: NotifySettingsOut = { language: 'ru', dateFormat: '24h', quietHours: DEFAULT_QUIET_HOURS };

export interface GiftShowcaseOut {
  enabled: boolean;
  partnerName: string;
}
const DEFAULT_GIFT_SHOWCASE: GiftShowcaseOut = { enabled: false, partnerName: 'Flocktory' };

export interface OpenSlotsScheduleOut {
  enabled: boolean;
  sendMorningToday: boolean;
  sendEveningTomorrow: boolean;
  timeMorning: string;
  timeEvening: string;
}
const DEFAULT_OPEN_SLOTS: OpenSlotsScheduleOut = {
  enabled: false,
  sendMorningToday: true,
  sendEveningTomorrow: true,
  timeMorning: '09:00',
  timeEvening: '19:00',
};

export interface PartnerSummaryOut {
  telegramEnabled: boolean;
  telegramChatLabel: string;
  emailEnabled: boolean;
  connectionWatchdog: boolean;
}
const DEFAULT_PARTNER_SUMMARY: PartnerSummaryOut = { telegramEnabled: false, telegramChatLabel: '', emailEnabled: false, connectionWatchdog: false };

export type AltegioWhatsAppMode = 'none' | 'notificationSender' | 'embeddedSignup' | 'coexistence';
export interface AltegioWhatsAppOut {
  mode: AltegioWhatsAppMode;
  templatesApproved: boolean;
  ownNumber?: string;
  companyName?: string;
}
const DEFAULT_ALTEGIO_WA: AltegioWhatsAppOut = { mode: 'none', templatesApproved: false };

export interface AgentFlagsOut {
  sendToClient: boolean;
  sendToAdmin: boolean;
}
const DEFAULT_AGENT_FLAGS: AgentFlagsOut = { sendToClient: true, sendToAdmin: true };

export interface BookingNotifyOverrideOut {
  sendOnSave: boolean;
  pushEnabled: boolean;
  pushTimingHours: number;
  smsEnabled: boolean;
  smsTimingHours: number;
  emailEnabled: boolean;
  emailTimingHours: number;
}
const DEFAULT_BOOKING_NOTIFY_OVERRIDE: BookingNotifyOverrideOut = {
  sendOnSave: true,
  pushEnabled: true,
  pushTimingHours: 1,
  smsEnabled: false,
  smsTimingHours: 1,
  emailEnabled: false,
  emailTimingHours: 12,
};

export type NotifyWebhookEntity = 'location' | 'staff' | 'clients' | 'bookings' | 'loyaltyCards' | 'services' | 'products' | 'sales';
export interface NotifyWebhookOut {
  id: string;
  url: string;
  entities: NotifyWebhookEntity[];
  active: boolean;
  createdAt: string;
}

@Injectable()
export class NotifyMoreService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  // ─────────── язык/формат/тихие часы (F-05-010/011, Ув12) ───────────

  async getSettings(businessId: string): Promise<NotifySettingsOut> {
    const [row, sysRow] = await Promise.all([
      this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_SETTINGS } } }),
      this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'system' } } }),
    ]);
    const own = { ...DEFAULT_SETTINGS, ...((row?.data as Partial<NotifySettingsOut>) ?? {}) };
    // Н5: язык сообщений клиентам — один источник (settings «Системные»), своё поле — только запасное
    const sysLanguage = (sysRow?.data as { messageLanguage?: 'ru' | 'hy' | 'en' } | undefined)?.messageLanguage;
    return { ...own, language: sysLanguage ?? own.language, quietHours: own.quietHours ?? DEFAULT_QUIET_HOURS };
  }

  async updateSettings(businessId: string, settings: NotifySettingsOut): Promise<NotifySettingsOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_SETTINGS } },
      create: { businessId, area: AREA_SETTINGS, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  // ─────────── ручная правка уведомлений ОДНОЙ записи (F-05-009/082) ───────────
  // Booking.notifyOverride (JSON, аддитивное поле, этап 21 «notify+integrations» попытка 3) — нет строки →
  // DEFAULT_BOOKING_NOTIFY_OVERRIDE действует (запись создана до этой правки или её никто не трогал).

  async getBookingOverride(businessId: string, bookingId: string): Promise<BookingNotifyOverrideOut> {
    const row = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { notifyOverride: true } });
    if (!row) throw new ApiError('not_found', 'Booking not found');
    return { ...DEFAULT_BOOKING_NOTIFY_OVERRIDE, ...((row.notifyOverride as Partial<BookingNotifyOverrideOut> | null) ?? {}) };
  }

  async updateBookingOverride(businessId: string, bookingId: string, override: BookingNotifyOverrideOut): Promise<BookingNotifyOverrideOut> {
    const row = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true } });
    if (!row) throw new ApiError('not_found', 'Booking not found');
    await this.prisma.booking.update({ where: { id: bookingId }, data: { notifyOverride: J(override) } });
    return override;
  }

  // ─────────── витрина подарков партнёра (F-05-127) ───────────

  async getGiftShowcase(businessId: string): Promise<GiftShowcaseOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_GIFT_SHOWCASE } } });
    return { ...DEFAULT_GIFT_SHOWCASE, ...((row?.data as Partial<GiftShowcaseOut>) ?? {}) };
  }

  async updateGiftShowcase(businessId: string, settings: GiftShowcaseOut): Promise<GiftShowcaseOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_GIFT_SHOWCASE } },
      create: { businessId, area: AREA_GIFT_SHOWCASE, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  // ─────────── Open Slots — только расписание рассылки, вычисление окон не входит в этот заход ───────────

  async getOpenSlotsSchedule(businessId: string): Promise<OpenSlotsScheduleOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_OPEN_SLOTS_SCHEDULE } } });
    return { ...DEFAULT_OPEN_SLOTS, ...((row?.data as Partial<OpenSlotsScheduleOut>) ?? {}) };
  }

  async updateOpenSlotsSchedule(businessId: string, settings: OpenSlotsScheduleOut): Promise<OpenSlotsScheduleOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_OPEN_SLOTS_SCHEDULE } },
      create: { businessId, area: AREA_OPEN_SLOTS_SCHEDULE, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  // ─────────── сводки и оповещения от партнёров (F-05-126) ───────────

  async getPartnerSummary(businessId: string): Promise<PartnerSummaryOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_PARTNER_SUMMARY } } });
    return { ...DEFAULT_PARTNER_SUMMARY, ...((row?.data as Partial<PartnerSummaryOut>) ?? {}) };
  }

  async updatePartnerSummary(businessId: string, settings: PartnerSummaryOut): Promise<PartnerSummaryOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_PARTNER_SUMMARY } },
      create: { businessId, area: AREA_PARTNER_SUMMARY, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  // ─────────── WhatsApp через Altegio (F-05-071…073) — статус/настройки, без реального обмена (Р19) ───────────

  async getAltegioWhatsApp(businessId: string): Promise<AltegioWhatsAppOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_ALTEGIO_WHATSAPP } } });
    return { ...DEFAULT_ALTEGIO_WA, ...((row?.data as Partial<AltegioWhatsAppOut>) ?? {}) };
  }

  private async saveAltegioWhatsApp(businessId: string, settings: AltegioWhatsAppOut): Promise<AltegioWhatsAppOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_ALTEGIO_WHATSAPP } },
      create: { businessId, area: AREA_ALTEGIO_WHATSAPP, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  updateAltegioWhatsApp(businessId: string, settings: AltegioWhatsAppOut): Promise<AltegioWhatsAppOut> {
    return this.saveAltegioWhatsApp(businessId, settings);
  }

  async setAltegioWhatsAppMode(businessId: string, mode: AltegioWhatsAppMode): Promise<AltegioWhatsAppOut> {
    const cur = await this.getAltegioWhatsApp(businessId);
    return this.saveAltegioWhatsApp(businessId, { ...cur, mode });
  }

  async approveWhatsAppTemplates(businessId: string): Promise<AltegioWhatsAppOut> {
    const cur = await this.getAltegioWhatsApp(businessId);
    return this.saveAltegioWhatsApp(businessId, { ...cur, templatesApproved: true });
  }

  // ─────────── флаги внешнего агента (F-05-121) ───────────

  async getAgentFlags(businessId: string): Promise<AgentFlagsOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_AGENT_FLAGS } } });
    return { ...DEFAULT_AGENT_FLAGS, ...((row?.data as Partial<AgentFlagsOut>) ?? {}) };
  }

  async updateAgentFlags(businessId: string, flags: AgentFlagsOut): Promise<AgentFlagsOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_AGENT_FLAGS } },
      create: { businessId, area: AREA_AGENT_FLAGS, data: J(flags) },
      update: { data: J(flags), version: { increment: 1 } },
    });
    return flags;
  }

  // ─────────── своё время напоминания на услугу (Ув15) — своя область, каталог типов тут не нужен ───────────

  async getServiceReminderHours(businessId: string, serviceId: string): Promise<number | null> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_SERVICE_REMINDER_HOURS } } });
    const map = (row?.data as Record<string, number> | undefined) ?? {};
    return map[serviceId] ?? null;
  }

  async setServiceReminderHours(businessId: string, serviceId: string, hours: number | null): Promise<void> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_SERVICE_REMINDER_HOURS } } });
    const map = { ...((row?.data as Record<string, number> | undefined) ?? {}) };
    if (hours === null) delete map[serviceId];
    else map[serviceId] = Math.max(0, hours);
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_SERVICE_REMINDER_HOURS } },
      create: { businessId, area: AREA_SERVICE_REMINDER_HOURS, data: J(map) },
      update: { data: J(map), version: { increment: 1 } },
    });
  }

  // ─────────── вебхуки внешних систем (F-05-120) — список per business, своя область ───────────
  // (не путать с WebhookAddress интеграций этапа 17 — другая форма, другой экран)

  async listWebhooks(businessId: string): Promise<NotifyWebhookOut[]> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_WEBHOOKS } } });
    return (row?.data as NotifyWebhookOut[] | undefined) ?? [];
  }

  private async saveWebhooks(businessId: string, list: NotifyWebhookOut[]): Promise<void> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_WEBHOOKS } },
      create: { businessId, area: AREA_WEBHOOKS, data: J(list) },
      update: { data: J(list), version: { increment: 1 } },
    });
  }

  async createWebhook(businessId: string, url: string, entities: NotifyWebhookEntity[]): Promise<NotifyWebhookOut> {
    if (!/^https?:\/\/.+/i.test(url.trim())) throw new ApiError('invalid_field', 'Invalid webhook url', { url: 'invalid' });
    if (entities.length === 0) throw new ApiError('invalid_field', 'No entities selected', { entities: 'required' });
    const list = await this.listWebhooks(businessId);
    const webhook: NotifyWebhookOut = { id: newId('notifyWebhook'), url: url.trim(), entities, active: true, createdAt: new Date().toISOString() };
    await this.saveWebhooks(businessId, [...list, webhook]);
    return webhook;
  }

  async setWebhookActive(businessId: string, webhookId: string, active: boolean): Promise<void> {
    const list = await this.listWebhooks(businessId);
    await this.saveWebhooks(
      businessId,
      list.map((w) => (w.id === webhookId ? { ...w, active } : w)),
    );
  }

  async deleteWebhook(businessId: string, webhookId: string): Promise<void> {
    const list = await this.listWebhooks(businessId);
    await this.saveWebhooks(
      businessId,
      list.filter((w) => w.id !== webhookId),
    );
  }

  // ─────────── письма от разделов-хозяев (F-05-129/131/134) — настоящий (fake) mail-адаптер, не браузерная фикция ───────────
  // Раздел-хозяин (финансы/отчёты/сеть) считает сам процесс; тут только отправка письма (Р14: mail/fake пишет в лог).

  async sendFiscalReceiptEmail(email: string, receiptUrl: string): Promise<{ sent: boolean }> {
    if (!email) throw new ApiError('invalid_field', 'Client has no email', { email: 'required' });
    await this.mail.send({ to: email, subject: 'Fiscal receipt', text: `Fiscal receipt for your visit: ${receiptUrl}` });
    return { sent: true };
  }

  async sendDataExportEmail(toEmail: string, reportLabel: string, downloadUrl: string): Promise<{ sent: boolean }> {
    await this.mail.send({ to: toEmail, subject: 'Data export', text: `Your export "${reportLabel}" is ready: ${downloadUrl}` });
    return { sent: true };
  }

  async sendPlanReportEmail(toEmail: string, downloadUrl: string, frequency: string): Promise<{ sent: boolean }> {
    if (frequency === 'off') throw new ApiError('invalid_field', 'Scheduling is off', { frequency: 'off' });
    await this.mail.send({ to: toEmail, subject: 'Plan progress report', text: `Plan progress report: ${downloadUrl}` });
    return { sent: true };
  }
}
