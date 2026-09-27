import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { IntegrationConnection } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { AppInstallOut, ConnectAppBody, RequestedScope, SystemUserOut } from './integrations.schemas.js';

const ACTIVATION_WINDOW_MS = 60 * 60 * 1000;

function view(row: {
  id: string;
  appId: string;
  businessId: string;
  locationId: string;
  status: string;
  grantedScopes: unknown;
  connectedAt: Date;
  activatesBy: Date | null;
  activatedAt: Date | null;
  disconnectedAt: Date | null;
  paidUntil: Date | null;
  systemUserId: string | null;
  errorText: string | null;
}): AppInstallOut {
  return {
    id: row.id,
    appId: row.appId,
    businessId: row.businessId,
    locationId: row.locationId,
    status: row.status as AppInstallOut['status'],
    grantedScopes: (row.grantedScopes as RequestedScope[] | null) ?? [],
    connectedAt: row.connectedAt.toISOString(),
    activatesBy: row.activatesBy?.toISOString(),
    activatedAt: row.activatedAt?.toISOString(),
    disconnectedAt: row.disconnectedAt?.toISOString(),
    paidUntil: row.paidUntil?.toISOString(),
    systemUserId: row.systemUserId ?? undefined,
    errorText: row.errorText ?? undefined,
  };
}

/**
 * Чужие — статус и настройки БЕЗ настоящего обмена (Р19, F-13-014…021). Каталог приложений (имя, цена,
 * builtinOnly, comingSoon…) остаётся на фронте (docs/PROGRESS.md, этап 17) — эти проверки уже сделаны там
 * ДО вызова сюда (`app.ownerOnly`/`app.price.model==='coming_soon'` в src/api/integrations.ts); сервер
 * проверяет только то, что не зависит от каталога: права, филиалы бизнеса, «встроенное не отключить».
 */
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** F-13-018: просроченное окно активации партнёром → error (тот же приём, что `withOverdue` фронта) */
  private overdue(row: IntegrationConnection | null): AppInstallOut | null {
    if (!row) return null;
    if (row.status === 'pendingActivation' && row.activatesBy && row.activatesBy.getTime() < Date.now()) {
      return view({ ...row, status: 'error', errorText: row.errorText ?? 'activationExpired' });
    }
    return view(row);
  }

  async listInstalled(businessId: string, locationIds: string[]): Promise<AppInstallOut[]> {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { businessId, locationId: { in: locationIds }, status: { not: 'disconnected' } },
      orderBy: { connectedAt: 'desc' },
    });
    return rows.map((r) => this.overdue(r)!);
  }

  async countForBusiness(businessId: string): Promise<number> {
    return this.prisma.integrationConnection.count({ where: { businessId, status: { not: 'disconnected' } } });
  }

  async getOne(businessId: string, appId: string, locationId: string): Promise<AppInstallOut | null> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { businessId, appId, locationId, status: { not: 'disconnected' } } });
    return this.overdue(row);
  }

  async liveLocationIds(businessId: string, appId: string, locationIds: string[]): Promise<string[]> {
    const rows = await this.prisma.integrationConnection.findMany({ where: { businessId, appId, locationId: { in: locationIds }, status: { not: 'disconnected' } } });
    return rows.map((r) => this.overdue(r)!).filter((i) => i.status === 'connected' || i.status === 'pendingActivation').map((i) => i.locationId);
  }

  async connect(businessId: string, body: ConnectAppBody): Promise<AppInstallOut[]> {
    const nowIso = new Date();
    const activatesBy = new Date(nowIso.getTime() + ACTIVATION_WINDOW_MS);
    const created: AppInstallOut[] = [];
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { businessId, appId: body.appId, locationId: { in: body.locationIds } } });
      for (const locationId of body.locationIds) {
        const id = newId('integrationConnection');
        const row = await tx.integrationConnection.create({
          data: body.instant
            ? { id, businessId, appId: body.appId, locationId, status: 'connected', grantedScopes: body.scopes, connectedAt: nowIso, activatedAt: nowIso }
            : { id, businessId, appId: body.appId, locationId, status: 'pendingActivation', grantedScopes: body.scopes, connectedAt: nowIso, activatesBy },
        });
        created.push(view(row));
      }
    });
    return created;
  }

  /** Демо-кнопка «Партнёр активировал» (F-13-018) */
  async activate(businessId: string, id: string): Promise<AppInstallOut> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Install not found');
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { status: 'connected', activatedAt: new Date(), paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), systemUserId: row.systemUserId ?? newId('integrationConnection') },
    });
    return view(updated);
  }

  async disconnect(businessId: string, id: string): Promise<void> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'Install not found');
    if (row.appId.startsWith('ia_builtin')) throw new ApiError('builtin_locked', 'Built-in app cannot be disconnected');
    await this.prisma.integrationConnection.update({ where: { id }, data: { status: 'disconnected', disconnectedAt: new Date() } });
  }

  /** F-13-019/059: живёт, пока install.status === 'connected' — appName достраивает фронт из своего каталога */
  async listSystemUsers(businessId: string, locationId: string): Promise<SystemUserOut[]> {
    const rows = await this.prisma.integrationConnection.findMany({ where: { businessId, locationId, status: 'connected', systemUserId: { not: null } } });
    return rows.map((r) => ({
      id: r.systemUserId!,
      appId: r.appId,
      installId: r.id,
      businessId: r.businessId,
      locationId: r.locationId,
      grantedScopes: (r.grantedScopes as RequestedScope[] | null) ?? [],
      connectedAt: r.connectedAt.toISOString(),
      billedInSubscription: false,
    }));
  }
}
