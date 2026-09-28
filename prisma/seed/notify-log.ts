import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/common/prisma.service.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;
const DAY = 86_400_000;
const J = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Этап 21, лейн notify-log+mailings: то же, что сеет мок фронта (src/mock/slices/notify.ts) — у каждого бизнеса
 * служебные строки журнала отправок (код первого входа, смена пароля, приглашение, выгрузка, чек, отчёт плана) и у
 * каждого второго бизнеса с клиентами две прошлые рассылки с получателями (фильтр «получал рассылку за N дней»).
 * Строки записей (напоминания, отмены…) не сеются — журнал выводит их сам из booking_events/bookings при первом
 * чтении (NotifyLogService.sync). Идемпотентно: детерминированные id/ключи, skipDuplicates.
 */
export async function seedNotifyLogFromMock(prisma: PrismaService, core: MockCore): Promise<void> {
  const now = Date.now();
  const at = (days: number) => new Date(now - days * DAY);
  const businesses = core.businesses as unknown as Rec[];
  const clients = core.clients as unknown as Rec[];
  const log: Prisma.NotifyLogEntryCreateManyInput[] = [];
  const mailings: Prisma.NotifyMailingCreateManyInput[] = [];
  const recipients: Prisma.NotifyMailingRecipientCreateManyInput[] = [];
  businesses.forEach((b, index) => {
    const bizId = String(b.id);
    const row = (key: string, days: number, typeLabel: Rec, channel: string, status: string, contact: string, text: Rec) =>
      log.push({ id: `nlg_${bizId}_${key}`.slice(0, 32), businessId: bizId, dedupeKey: `seed:${bizId}:${key}`, sentAt: at(days), typeLabel: J(typeLabel), channel, status, contact, text: J(text), costAmd: channel === 'sms' ? 50 : 0, smsParts: channel === 'sms' ? 2 : null, source: 'service' });
    row('signup', 30, { ru: 'Код для первого входа', en: 'First sign-in code' }, 'sms', 'delivered', '+374 00 100 000', {
      ru: 'Код для входа в кабинет: 482913. Пароль не нужен — входите по номеру и коду.',
      en: 'Your workspace sign-in code: 482913. No password needed — sign in with your phone and this code.',
    });
    row('pwd', 0.2, { ru: 'Изменение пароля', en: 'Password changed' }, 'email', 'delivered', 'owner@example.com', { ru: 'Пароль от кабинета изменён.', en: 'The workspace password was changed.' });
    row('invite', 0.1, { ru: 'Приглашение сотрудников с доступом', en: 'Staff access invitation' }, 'sms', 'sent', '+374 55 000 000', {
      ru: 'Вас пригласили в кабинет. Перейдите по ссылке, чтобы войти.',
      en: 'You were invited to the workspace. Follow the link to sign in.',
    });
    row('export', 2, { ru: 'Выгрузка данных (ссылка на email)', en: 'Data export (email link)' }, 'email', 'sent', 'owner@example.com', {
      ru: 'Ваша выгрузка «Клиентская база» готова: export.demo/clients-2026-09-24.xlsx',
      en: 'Your export "Client base" is ready: export.demo/clients-2026-09-24.xlsx',
    });
    row('fiscal', 1, { ru: 'Фискальный чек', en: 'Fiscal receipt' }, 'email', 'sent', 'client-demo@example.com', { ru: 'Фискальный чек по визиту: receipt.demo/9821', en: 'Fiscal receipt for your visit: receipt.demo/9821' });
    row('planreport', 7, { ru: 'Отчёт «Выполнение плана» (по расписанию)', en: 'Plan progress report (scheduled)' }, 'email', 'sent', 'network-owner@example.com', {
      ru: 'Отчёт «Выполнение плана»: plan-report.demo/2026-09.xlsx',
      en: 'Plan progress report: plan-report.demo/2026-09.xlsx',
    });

    const ids = clients.filter((c) => String(c.businessId) === bizId && !c.deletedAt).map((c) => String(c.id));
    if (index % 2 !== 0 || ids.length === 0) return;
    const recent = ids.slice(0, Math.max(1, Math.round(ids.length * 0.7)));
    const old = ids.slice(0, Math.max(1, Math.round(ids.length * 0.4)));
    const add = (n: number, days: number, channel: string, text: string, label: string, list: string[]) => {
      const id = `nml_${bizId}_${n}`.slice(0, 32);
      const cost = channel === 'sms' ? list.length * 25 : 0;
      mailings.push({ id, businessId: bizId, channel, text, audienceLabel: label, recipientsCount: list.length, status: 'sent', network: false, businessIds: J([bizId]), filter: J({}), createdAt: at(days), sentAt: at(days), costAmd: cost });
      list.forEach((clientId) => recipients.push({ mailingId: id, clientId, businessId: bizId, createdAt: at(days) }));
      log.push({ id: `nlg_${bizId}_ml${n}`.slice(0, 32), businessId: bizId, dedupeKey: `ml:${id}`, sentAt: at(days), typeLabel: J({ ru: 'Рассылка', en: 'Mailing', hy: 'Առաքում' }), channel: channel === 'sms' ? 'sms' : 'push', status: 'sent', contact: String(list.length), text: J({ ru: text }), costAmd: cost, source: 'mailing' });
    };
    add(1, 10, 'pushClientApp', 'Скидка 15% на маникюр всю неделю — успейте записаться!', 'Все клиенты', recent);
    add(2, 28, 'sms', 'Мы обновили расписание — новые окна уже открыты.', 'Постоянные клиенты', old);
  });
  const a = await prisma.notifyLogEntry.createMany({ skipDuplicates: true, data: log });
  const m = await prisma.notifyMailing.createMany({ skipDuplicates: true, data: mailings });
  await prisma.notifyMailingRecipient.createMany({ skipDuplicates: true, data: recipients });
  console.log(`seed: журнал отправок — служебных строк ${a.count}, рассылок ${m.count}, получателей ${recipients.length}`);
}
