import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { ApiKeyOut } from './integrations.schemas.js';

const TOKEN_PREFIX: Record<string, string> = { partner: 'pk_live', userToken: 'utok', aiAssistant: 'ai' };

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

/**
 * Своё — настоящее (F-13-052/053/071/072, docs/backend/02 §17): секрет генерируется один раз и не
 * восстанавливается — в базе только sha256-хеш + превью последних 4 символов. `KeysTab.tsx`/`McpTab.tsx`
 * фронта всегда маскируют `token` через `maskToken()` перед показом в списке (берёт последние 4 символа),
 * поэтому список отдаёт превью в том же поле `token` — экран не может различить полноценный секрет от
 * превью, и оба честно показывают одинаковый хвост (см. docs/PROGRESS.md, этап 17).
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  private view(row: { id: string; businessId: string; kind: string; label: string | null; scope: string | null; tokenPreview: string; createdAt: Date; revokedAt: Date | null }, rawToken?: string): ApiKeyOut {
    return {
      id: row.id,
      businessId: row.businessId,
      kind: row.kind as ApiKeyOut['kind'],
      label: row.label ?? undefined,
      scope: (row.scope as ApiKeyOut['scope']) ?? undefined,
      token: rawToken ?? `${'•'.repeat(8)}${row.tokenPreview}`,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString(),
    };
  }

  async list(businessId: string, kind: 'partner' | 'userToken' | 'aiAssistant'): Promise<ApiKeyOut[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { businessId, kind }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.view(r));
  }

  async issue(ctx: RequestContext, businessId: string, kind: 'partner' | 'userToken' | 'aiAssistant', opts: { label?: string; scope?: 'read' | 'readWrite' } = {}): Promise<ApiKeyOut> {
    const raw = `${TOKEN_PREFIX[kind]}_${crypto.randomBytes(24).toString('base64url')}`;
    const id = newId('apiKey');
    const row = await this.prisma.apiKey.create({
      data: {
        id,
        businessId,
        kind,
        label: opts.label ?? null,
        scope: opts.scope ?? null,
        tokenHash: sha256(raw),
        tokenPreview: raw.slice(-4),
        createdBy: ctx.member!.staffId,
      },
    });
    return this.view(row, raw);
  }

  async revoke(businessId: string, id: string): Promise<void> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, businessId } });
    if (!row) throw new ApiError('not_found', 'API key not found');
    if (row.revokedAt) return;
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}
