import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';

type Tx = Prisma.TransactionClient;

/**
 * «Замок на мастера» (PLAN.md §4.2, Р5) — ЕДИНСТВЕННОЕ место, которое пишет в busy_blocks и resource_busy.
 * Писать туда в обход этого сервиса запрещено.
 *
 * Любая операция, которая занимает время (запись, перенос, групповое событие, отметка «занят», дорога,
 * подтверждение заявки), вызывает occupy() ВНУТРИ своей транзакции (READ COMMITTED, без внешних вызовов):
 *   1. строки person_locks / resource_locks нужных людей и ресурсов берутся FOR UPDATE в порядке ключа
 *      (без порядка две записи на двух мастеров могут взаимно заблокироваться);
 *   2. проверяется пересечение с активной занятостью человека во ВСЕХ его бизнесах (F-00-045);
 *   3. пересечение → 409 slot_taken; нет — вставляются блоки.
 * После коммита вызывающий зовёт AvailabilityService.invalidate(...) — кеш окон и живые события.
 */

export interface BlockInput {
  /** users.id мастера; без аккаунта — staff.id (personKeyOf) */
  personKey: string;
  staffId: string;
  businessId: string;
  locationId?: string | null;
  workplace?: string | null;
  startAt: Date;
  /** С запасом после услуги и дорогой */
  endAt: Date;
  /** Конец самой услуги; нет — = endAt */
  serviceEndAt?: Date;
  source: 'booking' | 'group_event' | 'mark_busy' | 'travel';
  sourceId: string;
  /** Что видно чужому бизнесу (01 §7.2) */
  visibilityLabel: 'home' | 'salon' | 'visit' | 'busy';
  holdUntil?: Date | null;
}

export interface ResourceBlockInput {
  resourceId: string;
  /** Сколько экземпляров у ресурса (Resource.instances.length) */
  instances: number;
  businessId: string;
  startAt: Date;
  endAt: Date;
  source: BlockInput['source'];
  sourceId: string;
  holdUntil?: Date | null;
}

export interface OccupyInput {
  blocks: BlockInput[];
  resources?: ResourceBlockInput[];
  /** Сначала снять прежнюю занятость этого источника (перенос / правка) — в той же транзакции */
  replace?: { source: BlockInput['source']; sourceId: string };
  /**
   * Не проверять пересечения. Только для отметки «занят» (F-00-051): это слова самого мастера, а не запись —
   * она не может «не поместиться», но должна быть видна другим бизнесам человека как «занято».
   */
  allowOverlap?: boolean;
  /** Запись «не пришёл» не мешает (F-02-066, онлайн-запись поверх неявок) */
  ignoreNoShow?: boolean;
}

/** Ключ человека: мастер с аккаунтом — user_id, без аккаунта — staff.id */
export function personKeyOf(staff: { id: string; userId: string | null }): string {
  return staff.userId ?? staff.id;
}

/** Что показать чужому бизнесу по месту работы */
export function visibilityOf(workplace: string | null | undefined): BlockInput['visibilityLabel'] {
  if (workplace === 'home') return 'home';
  if (workplace === 'visit') return 'visit';
  return 'salon';
}

@Injectable()
export class OccupyService {
  /** FOR UPDATE по строкам замков в порядке ключа. Строки создаются при первом обращении. */
  async lock(tx: Tx, personKeys: readonly string[], resourceIds: readonly string[] = []): Promise<void> {
    const people = [...new Set(personKeys)].sort();
    const res = [...new Set(resourceIds)].sort();
    if (people.length) {
      await tx.$executeRaw`INSERT IGNORE INTO person_locks (person_key) VALUES ${Prisma.join(people.map((p) => Prisma.sql`(${p})`))}`;
      await tx.$queryRaw`SELECT person_key FROM person_locks WHERE person_key IN (${Prisma.join(people)}) ORDER BY person_key FOR UPDATE`;
    }
    if (res.length) {
      await tx.$executeRaw`INSERT IGNORE INTO resource_locks (resource_id) VALUES ${Prisma.join(res.map((r) => Prisma.sql`(${r})`))}`;
      await tx.$queryRaw`SELECT resource_id FROM resource_locks WHERE resource_id IN (${Prisma.join(res)}) ORDER BY resource_id FOR UPDATE`;
    }
  }

  /** Снять занятость источника (отмена, удаление, «не пришёл» без «поверх неявок» — решает вызывающий) */
  async release(tx: Tx, source: BlockInput['source'], sourceId: string): Promise<string[]> {
    const rows = await tx.busyBlock.findMany({ where: { source, sourceId, active: true }, select: { personKey: true } });
    await tx.busyBlock.updateMany({ where: { source, sourceId, active: true }, data: { active: false } });
    await tx.resourceBusy.updateMany({ where: { source, sourceId, active: true }, data: { active: false } });
    return [...new Set(rows.map((r) => r.personKey))];
  }

  /** Пометить «не пришёл» у занятости источника (F-02-066) */
  async setNoShow(tx: Tx, source: BlockInput['source'], sourceId: string, noShow: boolean): Promise<void> {
    await tx.busyBlock.updateMany({ where: { source, sourceId, active: true }, data: { noShow } });
    await tx.resourceBusy.updateMany({ where: { source, sourceId, active: true }, data: { noShow } });
  }

  /**
   * Занять время. Бросает 409 slot_taken, если время человека (или ресурса) уже занято. Возвращает ключи людей —
   * для сброса кеша окон после коммита.
   */
  async occupy(tx: Tx, input: OccupyInput): Promise<string[]> {
    const people = input.blocks.map((b) => b.personKey);
    const resourceIds = (input.resources ?? []).map((r) => r.resourceId);
    await this.lock(tx, people, resourceIds);
    if (input.replace) await this.release(tx, input.replace.source, input.replace.sourceId);

    if (!input.allowOverlap) {
      const now = new Date();
      for (const b of input.blocks) {
        const clash = await tx.busyBlock.findFirst({
          where: {
            personKey: b.personKey,
            active: true,
            source: { not: 'mark_busy' },
            startAt: { lt: b.endAt },
            endAt: { gt: b.startAt },
            OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
            ...(input.ignoreNoShow ? { noShow: false } : {}),
          },
          select: { id: true },
        });
        if (clash) throw new ApiError('slot_taken', 'Staff is busy at this time');
      }
      for (const r of input.resources ?? []) {
        const used = await tx.resourceBusy.count({
          where: {
            resourceId: r.resourceId,
            active: true,
            startAt: { lt: r.endAt },
            endAt: { gt: r.startAt },
            OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
            ...(input.ignoreNoShow ? { noShow: false } : {}),
          },
        });
        if (used >= r.instances) throw new ApiError('slot_taken', 'Resource is busy at this time');
      }
    }

    if (input.blocks.length) {
      await tx.busyBlock.createMany({
        data: input.blocks.map((b) => ({
          id: newId('busyBlock'),
          personKey: b.personKey,
          staffId: b.staffId,
          businessId: b.businessId,
          locationId: b.locationId ?? null,
          workplace: b.workplace ?? null,
          startAt: b.startAt,
          endAt: b.endAt,
          serviceEndAt: b.serviceEndAt ?? b.endAt,
          source: b.source,
          sourceId: b.sourceId,
          visibilityLabel: b.visibilityLabel,
          holdUntil: b.holdUntil ?? null,
        })),
      });
    }
    if (input.resources?.length) {
      await tx.resourceBusy.createMany({
        data: input.resources.map((r) => ({
          id: newId('resourceBusy'),
          resourceId: r.resourceId,
          businessId: r.businessId,
          startAt: r.startAt,
          endAt: r.endAt,
          source: r.source,
          sourceId: r.sourceId,
          holdUntil: r.holdUntil ?? null,
        })),
      });
    }
    return [...new Set(people)];
  }
}
