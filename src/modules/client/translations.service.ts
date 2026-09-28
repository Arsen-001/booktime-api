import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';

type Owner = 'staff' | 'business' | 'service';
type Localized = { ru?: string; en?: string } | null;

/**
 * Правка автоперевода на en (F-00-174), стадия 21 (лейн client+online, попытка 2). `client.ts::
 * getTranslationOverride/listTranslatable/setTranslationOverride`: мастер/бизнес поправил машинный перевод
 * своего текста — клиент видит исправленный, экран `/biz/apps/translations` собирает всё, что ru есть, en нет.
 */
@Injectable()
export class TranslationsService {
  constructor(private readonly prisma: PrismaService) {}

  private key(owner: Owner, ownerId: string, field: string) {
    return `${owner}:${ownerId}:${field}`;
  }

  async getOverride(owner: Owner, ownerId: string, field: string): Promise<string | undefined> {
    const row = await this.prisma.translationOverride.findUnique({ where: { owner_ownerId_field: { owner, ownerId, field } } });
    return row?.text;
  }

  async setOverride(owner: Owner, ownerId: string, field: string, text: string, updatedBy?: string): Promise<void> {
    const id = `${owner}_${ownerId}_${field}`.slice(0, 32);
    const trimmed = text.trim();
    if (!trimmed) {
      await this.prisma.translationOverride.deleteMany({ where: { owner, ownerId, field } });
      return;
    }
    await this.prisma.translationOverride.upsert({
      where: { owner_ownerId_field: { owner, ownerId, field } },
      create: { id, owner, ownerId, field, text: trimmed, updatedBy },
      update: { text: trimmed, updatedBy },
    });
  }

  /** Список текстов бизнеса, у которых есть ru, но нет en (для `/biz/apps/translations`) */
  async listTranslatable(businessId: string) {
    const [business, staff, services] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, description: true } }),
      this.prisma.staff.findMany({ where: { businessId }, select: { id: true, name: true, bio: true } }),
      this.prisma.service.findMany({ where: { businessId }, select: { id: true, name: true, description: true } }),
    ]);
    const overrideOf = (owner: Owner, ownerId: string, field: string) => this.prisma.translationOverride.findUnique({ where: { owner_ownerId_field: { owner, ownerId, field } } });
    const rows: { owner: Owner; ownerId: string; field: string; label: string; ru: string; override?: string }[] = [];

    const businessDesc = business?.description as Localized;
    if (businessDesc?.ru && !businessDesc.en?.trim()) {
      const ov = await overrideOf('business', business!.id, 'description');
      rows.push({ owner: 'business', ownerId: business!.id, field: 'description', label: business!.name, ru: businessDesc.ru, override: ov?.text });
    }
    for (const s of staff) {
      const bio = s.bio as Localized;
      if (bio?.ru && !bio.en?.trim()) {
        const ov = await overrideOf('staff', s.id, 'bio');
        rows.push({ owner: 'staff', ownerId: s.id, field: 'bio', label: s.name, ru: bio.ru, override: ov?.text });
      }
    }
    for (const sv of services) {
      const desc = sv.description as Localized;
      const name = sv.name as { ru?: string } | null;
      if (desc?.ru && !desc.en?.trim()) {
        const ov = await overrideOf('service', sv.id, 'description');
        rows.push({ owner: 'service', ownerId: sv.id, field: 'description', label: name?.ru ?? '', ru: desc.ru, override: ov?.text });
      }
    }
    return rows;
  }
}
