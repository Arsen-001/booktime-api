import { toMinutes } from '../availability/engine.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Освободившееся окно: мастер, услуги записи, длина и начало (местные день и минута от полуночи) */
export interface FreedWindow {
  staffId: string;
  serviceIds: string[];
  durationMin: number;
  date: string;
  startMin: number;
}

/** Заявка единого листа ожидания (waitlist_entries) — поля JSON как в базе */
export interface WaitlistWants {
  staffIds: unknown;
  serviceIds: unknown;
  wishes: unknown;
}

/**
 * Предложить ли заявке это окно и какую услугу (В-18, «Освободилось время»; сценарии 30.09: окно 30 мин ушло ждавшей
 * услугу на 45 мин). null — не предлагаем; строка — услуга для кнопки «Записаться» на это окно; undefined — окно без
 * услуги (у записи их не было). Правила:
 *  · мастер — из заявки (или «любой»);
 *  · услуга — освободившаяся из тех, что ждёт заявка, и только если её обычная длительность помещается в окно
 *    (запись могли укоротить); «любая услуга» — освободившаяся, тоже если помещается; ждёт другие — не предлагаем;
 *  · день и время — желания заявки (день или любой; точное время или интервал), как waitlistWantsSlot фронта.
 * Как collectRecipients мока (journal-offers.ts, freeMin) и notifyWaitlist (client.ts).
 */
export function waitlistOffer(e: WaitlistWants, w: FreedWindow, durations: ReadonlyMap<string, number>): string | undefined | null {
  const staffIds = arr(e.staffIds);
  if (staffIds.length && !staffIds.includes(w.staffId)) return null;
  const fits = (id: string) => (durations.get(id) ?? Number.POSITIVE_INFINITY) <= w.durationMin;
  const wanted = arr(e.serviceIds);
  let service: string | undefined;
  if (!wanted.length) {
    service = w.serviceIds[0];
    if (service !== undefined && !fits(service)) return null;
  } else {
    service = wanted.find((id) => w.serviceIds.includes(id) && fits(id));
    if (service === undefined && w.serviceIds.length) return null;
    service ??= wanted.find(fits);
    if (service === undefined) return null;
  }
  const wishes = arr<{ date?: string; time?: string; intervals?: { from: string; to: string }[] }>(e.wishes);
  const wantsTime =
    !wishes.length ||
    wishes.some((x) => {
      if (x.date && x.date !== w.date) return false;
      if (x.intervals?.length) return x.intervals.some((i) => toMinutes(i.from) <= w.startMin && w.startMin < toMinutes(i.to));
      return !x.time || toMinutes(x.time) === w.startMin;
    });
  return wantsTime ? service : null;
}
