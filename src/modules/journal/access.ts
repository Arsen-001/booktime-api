import { Inject, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/http/context.js';
import { MEMBERSHIP_RESOLVER, type MembershipResolver } from '../../common/http/resolvers.js';

/**
 * «Все филиалы» (F-01-006, F-00-050): журнал сети смотрит записи нескольких бизнесов. Бизнес из пути уже проверен
 * BizGuard; остальные из ?businessIds= берутся, только если у вошедшего и там есть членство с journal.view.
 */
@Injectable()
export class JournalAccess {
  constructor(@Inject(MEMBERSHIP_RESOLVER) private readonly memberships: MembershipResolver) {}

  async businessIds(ctx: RequestContext, raw?: string | string[]): Promise<string[]> {
    const own = ctx.member!.businessId;
    const list = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
    const out = [own];
    for (const id of new Set(list)) {
      if (id === own || !ctx.session) continue;
      const m = await this.memberships.resolve(ctx.session, id);
      if (m?.permissions.has('journal.view')) out.push(id);
    }
    return out;
  }
}

export const csv = (v?: string | string[]) =>
  (Array.isArray(v) ? v.join(',') : (v ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
