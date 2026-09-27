import { z } from 'zod';
import { isLocalDate } from '../../common/time/time.js';

/** Схемы раздела «График и окна» (docs/backend/02 §5). Формы — как типы фронта src/api/schedule/* и domain/schedule.ts */

export const id32 = z.string().min(1).max(32);
export const isoDate = z.string().refine(isLocalDate, 'YYYY-MM-DD');
export const hm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'HH:mm');
export const timeRange = z.object({ from: hm, to: hm });
export const dayHours = z.array(timeRange).max(12);
export const dayTypeId = z.string().regex(/^(work|sick|vacation|unpaid_leave|absence|paid_day_off|not_working|custom:[\w-]{1,30})$/);
export const workplace = z.enum(['salon', 'home', 'visit', 'hall', 'online']);
export const historyAction = z.enum(['set_hours', 'apply_template', 'delete_days', 'copy_schedule', 'set_mode', 'toggle_mark', 'set_column_config', 'slot_rules']);
export const scopeKind = z.enum(['location', 'staff']);

const dates = z.array(isoDate).min(1).max(1100);
const staffIds = z.array(id32).min(1).max(200);

export const tableBody = z.object({
  locationIds: z.array(id32).max(50).default([]),
  from: isoDate,
  to: isoDate,
  filters: z
    .object({
      staffIds: z.array(id32).max(200),
      positions: z.array(z.string().max(120)).max(50),
      specializations: z.array(z.string().max(40)).max(100),
      hasSchedule: z.enum(['all', 'with', 'without']),
      deleted: z.enum(['active', 'only']),
      fired: z.enum(['active', 'only']),
    })
    .partial()
    .optional(),
});
export type TableBody = z.infer<typeof tableBody>;

export const setCellsBody = z.object({
  staffIds,
  dates,
  typeId: dayTypeId,
  hours: dayHours.default([]),
  locationId: id32.optional(),
  vacationUntil: isoDate.optional(),
  historyAction: historyAction.optional(),
  force: z.boolean().optional(),
});
export type SetCellsBody = z.infer<typeof setCellsBody>;

export const deleteCellsBody = z.object({ staffIds, dates, force: z.boolean().optional() });
export const snapshotBody = z.object({ staffIds, dates });
export const cellSnapshot = z.object({ staffId: id32, date: isoDate, hours: dayHours, typeId: dayTypeId });
export const restoreCellsBody = z.object({ snapshot: z.array(cellSnapshot).max(20000) });
export const affectedBody = z.object({ staffIds, dates, newHours: dayHours.optional() });
export const hasSavedBody = z.object({ staffIds: z.array(id32).max(200) });

export const copyBody = z.object({
  fromStaffId: id32,
  toStaffIds: staffIds,
  from: isoDate,
  to: isoDate,
  includeBreaks: z.boolean(),
});
export const copyLastWeekBody = z.object({ staffId: id32, weekAnchor: isoDate });

export const templateBody = z.object({
  id: id32.optional(),
  name: z.string().max(120).default(''),
  kind: z.enum(['weekdays', 'shifts']),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  shiftWork: z.number().int().min(1).max(30).optional(),
  shiftOff: z.number().int().min(0).max(30).optional(),
  hours: dayHours,
});
export const templatePatch = templateBody.omit({ id: true }).partial();

export const settingsPatch = z
  .object({
    anySpecialistAllowed: z.boolean(),
    allowOnlineOverNoShow: z.boolean(),
    planningPeriodYears: z.union([z.literal(1), z.literal(1.5), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    notifyMasterOnScheduleChange: z.boolean(),
    /** Карты по сотруднику: null — снять ключ */
    skipStaffSelection: z.record(z.string(), z.boolean().nullable()),
    historyLimitDays: z.record(z.string(), z.number().int().min(0).max(3650).nullable()),
    includeInFillRate: z.record(z.string(), z.boolean().nullable()),
    googleCalendar: z.record(z.string(), z.object({ connected: z.boolean(), shareClientNames: z.boolean() }).nullable()),
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsPatch>;

export const journalViewBody = z
  .object({
    hiddenInJournal: z.boolean(),
    journalMarkupMin: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(90), z.literal(120)]).nullable(),
  })
  .partial();

export const addWorkDaysBody = z.object({ dates, hours: dayHours.optional(), locationId: id32.optional() });
export const oneDateBody = z.object({ date: isoDate });
export const removeFromScheduleBody = z.object({ force: z.boolean().default(false) });
export const restoreAfterRemoveBody = z.object({
  snapshot: z.object({ cells: z.array(cellSnapshot).max(20000), openUntil: isoDate.nullable().optional() }),
});

// ─────────── календарь мастера ───────────

export const calendarModeBody = z.object({ mode: z.enum(['free', 'busy']) });
export const markBody = z.object({
  date: isoDate,
  from: hm,
  to: hm,
  kind: z.enum(['busy', 'free']),
  workplace: workplace.optional(),
  note: z.string().max(300).optional(),
});
export const markSnapshot = markBody.extend({ id: z.string().max(32).optional(), staffId: id32.optional() });
export const restoreMarksBody = z.object({ from: isoDate, to: isoDate, marks: z.array(markSnapshot).max(2000) });
export const rangeBody = z.object({ date: isoDate, from: hm, to: hm });
export const fromToBody = z.object({ from: isoDate, to: isoDate });
export const weekAnchorBody = z.object({ weekAnchor: isoDate });
export const vacationBody = z.object({ until: isoDate });
export const calendarDayBody = z.object({ date: isoDate, typeId: dayTypeId, hours: dayHours.default([]), force: z.boolean().optional() });

// ─────────── окна и правила ───────────

const intish = z.coerce.number().int();
export const slotsQuery = z.object({
  date: isoDate,
  durationMin: intish.min(5).max(24 * 60),
  durationMax: intish.min(5).max(24 * 60).optional(),
  bufferAfterMin: intish.min(0).max(24 * 60).optional(),
  locationId: id32.optional(),
  stepMin: intish.min(5).max(420).optional(),
  serviceId: id32.optional(),
});
export const nearestQuery = slotsQuery.omit({ date: true }).extend({ days: intish.min(1).max(60).optional(), limit: intish.min(1).max(50).optional() });
export const quickSlotsQuery = z.object({ date: isoDate, serviceId: id32.optional(), locationId: id32.optional() });
export const anySpecialistQuery = slotsQuery.extend({ locationId: id32 });
export const utilizationQuery = z.object({ staffIds: z.string().max(4000), from: isoDate, to: isoDate, locationId: id32.optional() });

export const slotRule = z.object({
  id: z.string().max(32).default(''),
  isBase: z.boolean(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  density: z.enum(['fixed', 'optimal', 'dynamic']),
  startMode: z.enum(['from_window', 'from_shift_start']),
  windowFrom: hm,
  windowTo: hm,
  stepMin: z.number().int().min(5).max(420),
  leadTimeMin: z.number().int().min(0).max(60 * 24 * 60).optional().nullable(),
  disabledSlots: z.array(hm).max(300),
  name: z.string().max(120).optional(),
});
export type SlotRuleBody = z.infer<typeof slotRule>;
export const toggleSlotBody = z.object({ time: hm });
export const togglePartBody = z.object({ times: z.array(hm).max(300), enable: z.boolean() });
export const slotModeBody = z.object({ mode: z.enum(['location', 'own']), locationId: id32 });
export const unavailableBody = z.object({ from: isoDate, to: isoDate, note: z.string().max(300).optional() });
export const bufferBody = z.object({ minutes: z.number().int().min(0).max(24 * 60) });
export const serviceWindowBody = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  hoursFrom: hm.optional(),
  hoursTo: hm.optional(),
  days: z.enum(['any', 'weekdays', 'weekends', 'custom']),
  customDates: z.array(isoDate).max(400).optional(),
});
export const effectiveRuleQuery = z.object({ staffId: id32, locationId: id32, date: isoDate });
