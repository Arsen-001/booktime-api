/**
 * Права — ТОТ ЖЕ список, что во фронте (booking-platform/src/config/permissions.ts, PLAN.md §5: «права лежат в одном
 * файле»). Сервер хранит копию; `npm run check:permissions` сверяет её с фронтом и падает при расхождении.
 * Эффективные права сотрудника = шаблон его роли + галочки владельца (docs/backend/03-access-privacy.md §2).
 */
export const PERMISSIONS = [
  'journal.view',
  'journal.edit',
  'journal.create',
  'journal.reschedule',
  'journal.others',
  'journal.stats',
  'clients.view',
  'clients.phones',
  'clients.edit',
  'clients.export',
  'clients.delete',
  'schedule.edit',
  'services.view',
  'services.edit',
  'staff.view',
  'staff.manage',
  'online.manage',
  'online.own',
  'notify.manage',
  'notify.mailings',
  'notify.log',
  'loyalty.manage',
  'loyalty.rules',
  'loyalty.applyWithoutCode',
  'finance.view',
  'finance.edit',
  'stock.view',
  'stock.edit',
  'payroll.view',
  'payroll.manage',
  'resources.manage',
  'reports.view',
  'network.manage',
  'network.addLocation',
  'integrations.manage',
  'integrations.webhooksEdit',
  'settings.manage',
  'billing.manage',
  'platform.access',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

const ALL_BIZ = PERMISSIONS.filter((p) => p !== 'platform.access');

/** Роль сотрудника в бизнесе (docs/backend/03 §1). individual — владелец бизнеса kind=individual. */
export type StaffRole = 'owner' | 'individual' | 'admin' | 'master' | 'network';

/** Шаблоны ролей — те же, что PERSONA_PERMISSIONS фронта для этих персон */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  owner: ALL_BIZ,
  network: ALL_BIZ,
  individual: ALL_BIZ.filter((p) => p !== 'network.manage' && p !== 'staff.manage' && p !== 'journal.others'),
  admin: [
    'journal.view',
    'journal.edit',
    'journal.create',
    'journal.reschedule',
    'journal.others',
    'journal.stats',
    'clients.view',
    'clients.phones',
    'clients.edit',
    'schedule.edit',
    'services.view',
    'staff.view',
    'online.manage',
    'online.own',
    'stock.view',
    'resources.manage',
  ],
  master: [
    'journal.view',
    'journal.edit',
    'journal.create',
    'journal.reschedule',
    'clients.view',
    'schedule.edit',
    'services.view',
    'stock.view',
    'payroll.view',
    'online.own',
  ],
};

/**
 * Итоговые права: у администратора владелец задаёт набор галочками целиком (как setStaffPermissions во фронте —
 * override заменяет шаблон), у остальных — шаблон роли.
 */
export function effectivePermissions(role: StaffRole, override?: readonly string[] | null): ReadonlySet<Permission> {
  const list = role === 'admin' && override ? override.filter(isPermission) : ROLE_PERMISSIONS[role];
  return new Set(list);
}
