import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { clientRowView } from './clients.views.js';
import { cleanImportRow, fillEmptyPatch, IMPORT_BATCH_MAX, type ImportRowInput } from './clients-import.rules.js';
import { recordDataOp } from '../staff/data-ops.js';

type ImportStatus = 'created' | 'updated' | 'skipped' | 'error';
type ImportCode = 'exists' | 'nothingToFill' | 'duplicateInFile' | 'phoneFormat' | 'noPhone' | 'invalid';
export interface ImportRowResult {
  rowIndex: number;
  status: ImportStatus;
  code?: ImportCode;
  clientId?: string;
}

export interface ImportBatchArgs {
  rows: ImportRowInput[];
  onExisting: 'skip' | 'fillEmpty';
  dryRun?: boolean;
  runId?: string;
  authorName: string;
  method: 'paste' | 'file';
  rejectedBeforeSend?: number;
}

/**
 * Импорт клиентов пачками (F-04-126…129, F-00-190; «переезд за минуту», 04.10.2026). Номер — ключ клиента бизнеса:
 * повтор того же файла не создаёт дублей и ничего не удваивает. Номер уже в базе: «skip» — пропустить,
 * «fillEmpty» — дописать только пустые поля (fillEmptyPatch). Пачка пишется одной транзакцией; dryRun — то же
 * решение по каждой строке без записи (экран показывает «новых / уже в базе / не загрузятся» до загрузки).
 */
@Injectable()
export class ClientsImportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async importBatch(ctx: RequestContext, businessId: string, args: ImportBatchArgs): Promise<{ runId?: string; results: ImportRowResult[] }> {
    if (args.rows.length > IMPORT_BATCH_MAX) throw new ApiError('too_many_rows', `Up to ${IMPORT_BATCH_MAX} rows per call`);
    const results: ImportRowResult[] = [];
    const clean: ImportRowInput[] = [];
    const seen = new Set<string>();
    for (const raw of args.rows) {
      const c = cleanImportRow(raw);
      if ('error' in c) {
        results.push({ rowIndex: raw.rowIndex, status: 'error', code: c.error });
        continue;
      }
      if (seen.has(c.row.phone)) {
        results.push({ rowIndex: raw.rowIndex, status: 'skipped', code: 'duplicateInFile' });
        continue;
      }
      seen.add(c.row.phone);
      clean.push(c.row);
    }

    const staffId = ctx.member!.staffId;
    const apply = async (tx: Prisma.TransactionClient | PrismaService) => {
      const existing = clean.length
        ? await tx.client.findMany({ where: { businessId, deletedAt: null, phone: { in: clean.map((r) => r.phone) } } })
        : [];
      const byPhone = new Map(existing.map((c) => [c.phone, c]));
      const toCreate: Prisma.ClientCreateManyInput[] = [];
      for (const row of clean) {
        const ex = byPhone.get(row.phone);
        if (ex) {
          if (args.onExisting === 'skip') {
            results.push({ rowIndex: row.rowIndex, status: 'skipped', code: 'exists', clientId: ex.id });
            continue;
          }
          const patch = fillEmptyPatch(ex, row);
          if (Object.keys(patch).length === 0) {
            results.push({ rowIndex: row.rowIndex, status: 'skipped', code: 'nothingToFill', clientId: ex.id });
            continue;
          }
          if (!args.dryRun) {
            await tx.client.update({ where: { id: ex.id }, data: { ...patch, updatedBy: staffId, version: { increment: 1 } } });
          }
          results.push({ rowIndex: row.rowIndex, status: 'updated', clientId: ex.id });
          continue;
        }
        if (args.dryRun) {
          results.push({ rowIndex: row.rowIndex, status: 'created' });
          continue;
        }
        const id = newId('client');
        toCreate.push({
          id,
          businessId,
          phone: row.phone,
          name: row.name,
          lastName: row.lastName ?? null,
          gender: row.gender ?? 'unknown',
          birthday: row.birthday ?? null,
          email: row.email ?? null,
          note: row.note ?? null,
          tags: row.tags ?? [],
          additionalPhone: row.additionalPhone ?? null,
          discountPercent: row.discountPercent ?? 0,
          cardNumber: row.cardNumber ?? null,
          importedSold: BigInt(row.sold ?? 0),
          paidAmount: BigInt(row.paid ?? 0),
          source: 'import',
          createdBy: staffId,
          updatedBy: staffId,
        });
        results.push({ rowIndex: row.rowIndex, status: 'created', clientId: id });
      }
      if (toCreate.length) await tx.client.createMany({ data: toCreate });
    };

    if (args.dryRun) {
      await apply(this.prisma);
      return { results: results.sort((a, b) => a.rowIndex - b.rowIndex) };
    }

    const count = (s: ImportStatus) => results.filter((r) => r.status === s).length;
    let runId = args.runId;
    await this.prisma.$transaction(
      async (tx) => {
        await apply(tx);
        const created = count('created');
        const updated = count('updated');
        const errors = count('error');
        // Прогон из нескольких пачек — одна строка журнала: первая пачка создаёт, следующие прибавляют
        const prev = runId ? await tx.clientImportRun.findFirst({ where: { id: runId, businessId } }) : null;
        if (prev) {
          await tx.clientImportRun.update({
            where: { id: prev.id },
            data: {
              totalRows: { increment: args.rows.length },
              createdCount: { increment: created },
              updatedCount: { increment: updated },
              rejectedCount: { increment: errors },
            },
          });
        } else {
          const before = args.rejectedBeforeSend ?? 0;
          runId = newId('clientImportRun');
          await tx.clientImportRun.create({
            data: {
              id: runId,
              businessId,
              authorName: args.authorName,
              method: args.method,
              totalRows: args.rows.length + before,
              createdCount: created,
              updatedCount: updated,
              rejectedCount: errors + before,
            },
          });
        }
        await this.audit.record(tx, ctx, {
          action: 'import',
          entityType: 'clientImport',
          entityId: runId!,
          businessId,
          after: { created, updated, skipped: count('skipped'), rejected: errors, onExisting: args.onExisting },
        });
        // «Операции с данными»: одна строка на прогон (пачки прибавляют), числа — итог прогона
        const run = await tx.clientImportRun.findFirst({ where: { id: runId!, businessId } });
        if (run) {
          await recordDataOp(
            tx,
            ctx,
            businessId,
            { kind: 'import', area: 'clients', entity: 'clients', count: run.createdCount + run.updatedCount, ...(run.rejectedCount ? { failed: run.rejectedCount } : {}) },
            run.id,
          );
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return { runId, results: results.sort((a, b) => a.rowIndex - b.rowIndex) };
  }

  async listImportRuns(businessId: string) {
    const rows = await this.prisma.clientImportRun.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 50 });
    // Пропущенные отдельной колонкой не хранятся: всё, что не создано, не дополнено и не отклонено
    return rows.map((r) => ({ ...r, at: r.at.toISOString(), skippedCount: Math.max(0, r.totalRows - r.createdCount - r.updatedCount - r.rejectedCount) }));
  }

  // ─────────── выгрузка (F-04-130, P4: закрыта по умолчанию, право clients.export) ───────────

  async exportClients(ctx: RequestContext, businessId: string, ids: string[], authorName: string, fileName: string) {
    const rows = await this.prisma.client.findMany({ where: { id: { in: ids }, businessId, deletedAt: null } });
    const view = rows.map(clientRowView);
    await this.prisma.$transaction(async (tx) => {
      await tx.dataExport.create({ data: { id: newId('dataExport'), businessId, area: 'clients', authorId: ctx.member!.staffId, authorName, count: view.length, fileName } });
      await this.audit.record(tx, ctx, { action: 'export', entityType: 'clientExport', entityId: businessId, businessId, after: { count: view.length, fileName } });
      await recordDataOp(tx, ctx, businessId, { kind: 'export', area: 'clients', entity: 'clients', count: view.length, fileName });
    });
    return view;
  }

  async listExportLog(businessId: string) {
    const rows = await this.prisma.dataExport.findMany({ where: { businessId, area: 'clients' }, orderBy: { at: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), authorName: r.authorName, count: r.count, method: 'download' as const }));
  }
}
