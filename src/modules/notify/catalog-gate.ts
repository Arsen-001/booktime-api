import type { PrismaService } from '../../common/prisma.service.js';
import { clientPrefsOf, ClientTypeConfigs, type ClientPrefs } from './client-auto.js';

/**
 * ⭐ Переключатели каталога «Уведомления» действуют на всё, что уходит (06.10.2026, охват ТЗ 06.10 п. 4 №4): строка
 * очереди с `meta.typeCode` проходит через настройки этого типа у бизнеса и настройки клиента — у отправителя очереди
 * (notify-dispatch.service.ts), одним местом для всех отправителей. Раньше «Администратор записал клиента» (8),
 * «Изменение записи» (74), «Отмена записи» (4) и пуши администраторам о действиях клиента (10/12/41) уходили и при
 * выключенном типе — салон видел выключатель, который ничего не выключал.
 *
 * Пропуск (причина — `lastError` строки очереди, журнал отправок такие строки не показывает):
 *  · `type_disabled` — тип выключен бизнесом или у канала строки сценарий «Не отправлять»
 *    (пуш клиенту — push / brandedApp; администратору — adminApp; Telegram-бот — telegram, если он есть в типе);
 *  · `client_type_off` — клиент выключил этот тип у себя (F-04-087…090);
 *  · `client_push_off` — клиент выключил пуши (только пуш в приложение; Telegram — его отдельный выбор).
 * «Запись подтверждена» (9) уходит и при выключенном типе (F-05-026 п. 2) — у таких строк typeCode в meta не ставится.
 */
export type GateSkip = 'type_disabled' | 'client_type_off' | 'client_push_off';

export class CatalogGate {
  private readonly types: ClientTypeConfigs;
  private readonly prefs = new Map<string, Promise<ClientPrefs | undefined>>();

  constructor(private readonly db: PrismaService) {
    this.types = new ClientTypeConfigs(db);
  }

  async check(row: { businessId: string | null; app: string; meta: unknown }): Promise<GateSkip | null> {
    const meta = (row.meta as { typeCode?: unknown; clientId?: unknown } | null) ?? {};
    if (!row.businessId || typeof meta.typeCode !== 'number') return null;
    const type = await this.types.get(row.businessId, meta.typeCode);
    if (!type.alwaysOn) {
      if (!type.enabled) return 'type_disabled';
      const scenario = (ch: string) => type.channels.find((c) => c.channel === ch)?.scenario;
      if (row.app === 'client' && scenario('push') === 'off' && (scenario('brandedApp') ?? 'off') === 'off') return 'type_disabled';
      if (row.app === 'business' && scenario('adminApp') === 'off') return 'type_disabled';
      if (row.app === 'telegram' && scenario('telegram') === 'off') return 'type_disabled';
    }
    if (row.app === 'business' || typeof meta.clientId !== 'string') return null;
    const prefs = await this.prefsOf(meta.clientId);
    if (prefs?.disabledTypeCodes.includes(meta.typeCode)) return 'client_type_off';
    if (row.app === 'client' && prefs && !prefs.push) return 'client_push_off';
    return null;
  }

  private prefsOf(clientId: string): Promise<ClientPrefs | undefined> {
    let p = this.prefs.get(clientId);
    if (!p) {
      p = clientPrefsOf(this.db, [clientId]).then((m) => m.get(clientId));
      this.prefs.set(clientId, p);
    }
    return p;
  }
}
