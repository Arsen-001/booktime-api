import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../ids/ids.js';
import type { RequestContext } from '../http/context.js';
import { fanOutWebhooks } from './webhook-fanout.js';

export type ActorType = 'staff' | 'client' | 'link_holder' | 'system' | 'platform';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  businessId?: string | null;
  networkId?: string | null;
  /** Было / стало — пишутся только различающиеся поля */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

type Diff = Record<string, [unknown, unknown]>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SKIP = new Set(['updatedAt', 'updated_at', 'version']);

export function diffOf(before?: Record<string, unknown> | null, after?: Record<string, unknown> | null): Diff | null {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const diff: Diff = {};
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    const a = before?.[k] ?? null;
    const b = after?.[k] ?? null;
    if (!same(a, b)) diff[k] = [a, b];
  }
  return Object.keys(diff).length ? diff : null;
}

const PHONE_KEYS = /phone/i;

/** Для читателя без права clients.phones: телефоны в diff маскируются, как на экранах (утечку F-10-093 не повторять) */
export function maskPhonesInDiff(diff: Diff | null): Diff | null {
  if (!diff) return diff;
  const mask = (v: unknown) => (typeof v === 'string' && v.length > 4 ? `${v.slice(0, 4)}•••••${v.slice(-2)}` : v);
  return Object.fromEntries(Object.entries(diff).map(([k, [a, b]]) => [k, PHONE_KEYS.test(k) ? [mask(a), mask(b)] : [a, b]]));
}

/** Кто действует — из контекста запроса */
export function actorOf(ctx: RequestContext | null): { actorType: ActorType; actorId: string | null; actorName: string } {
  if (!ctx) return { actorType: 'system', actorId: null, actorName: 'system' };
  if (ctx.member) return { actorType: 'staff', actorId: ctx.member.staffId, actorName: ctx.member.name };
  if (ctx.session?.platform) return { actorType: 'platform', actorId: ctx.session.userId, actorName: 'platform' };
  if (ctx.session) return { actorType: 'client', actorId: ctx.session.userId, actorName: 'client' };
  return { actorType: 'link_holder', actorId: null, actorName: 'link_holder' };
}

@Injectable()
export class AuditService {
  /** Записать событие в ТОЙ ЖЕ транзакции, что и правка: await audit.record(tx, ctx, { … }) */
  async record(tx: Prisma.TransactionClient, ctx: RequestContext | null, input: AuditInput): Promise<void> {
    const diff = diffOf(input.before, input.after);
    if (input.action === 'update' && !diff) return; // сохранили без изменений — строки не нужно
    await tx.auditEvent.create({
      data: {
        id: newId('auditEvent'),
        businessId: input.businessId ?? ctx?.member?.businessId ?? null,
        networkId: input.networkId ?? null,
        ...actorOf(ctx),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        diff: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
        device: ctx?.device ?? null,
      },
    });
    // Этап 17: одна и та же транзакция — доставка вебхука коммитится, только если коммитится сама правка
    await fanOutWebhooks(tx, input.businessId ?? ctx?.member?.businessId ?? null, input);
  }
}
