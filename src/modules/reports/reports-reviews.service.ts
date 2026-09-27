import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { inRange, type ReportRange } from './reports-common.js';

/**
 * «Отзывы» (F-12-068…069, В-24, docs/backend/02 §16 `reviews`), этап 21 «network+reports». Три источника —
 * ⭐ звёздочка мастеру без текста (`StarRating`, дефолт), оценка 1–5 + текст (`StaffReview`, когда
 * `online.reviewMode` бизнеса = 'text', этап 21 «client» уже завёл модель) и отзыв о месте (`LocationReview`,
 * `kind: 'company'`). `StarRating` без `businessId` — считаем бизнес через `Staff.businessId`.
 */
@Injectable()
export class ReportsReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(businessId: string, filters: { range: ReportRange; subject: string }) {
    const staffAll = await this.prisma.staff.findMany({ where: { businessId }, select: { id: true, name: true } });
    const staffIds = staffAll.map((s) => s.id);
    const staffNameOf = new Map(staffAll.map((s) => [s.id, s.name] as const));
    const staffFilter = filters.subject !== 'all' && filters.subject !== 'company' ? filters.subject : undefined;

    const rows: {
      id: string;
      kind: 'company' | 'staffStar' | 'staffReview';
      staffName?: string;
      text?: string;
      rating?: number;
      hiddenByBusiness?: boolean;
      createdAt: string;
    }[] = [];

    if (filters.subject === 'all' || filters.subject === 'company') {
      const companyReviews = await this.prisma.locationReview.findMany({ where: { businessId }, select: { id: true, text: true, createdAt: true } });
      for (const r of companyReviews) {
        const at = r.createdAt.toISOString();
        if (!inRange(at.slice(0, 10), filters.range)) continue;
        rows.push({ id: r.id, kind: 'company', text: r.text, createdAt: at });
      }
    }

    if ((filters.subject === 'all' || staffFilter) && staffIds.length) {
      const scopedStaffIds = staffFilter ? [staffFilter] : staffIds;
      const stars = await this.prisma.starRating.findMany({ where: { staffId: { in: scopedStaffIds } }, select: { id: true, staffId: true, createdAt: true } });
      for (const r of stars) {
        const at = r.createdAt.toISOString();
        if (!inRange(at.slice(0, 10), filters.range)) continue;
        const staffName = staffNameOf.get(r.staffId);
        if (!staffName) continue;
        rows.push({ id: r.id, kind: 'staffStar', staffName, createdAt: at });
      }
      const staffReviews = await this.prisma.staffReview.findMany({
        where: { businessId, staffId: { in: scopedStaffIds } },
        select: { id: true, staffId: true, text: true, rating: true, hidden: true, createdAt: true },
      });
      for (const r of staffReviews) {
        const at = r.createdAt.toISOString();
        if (!inRange(at.slice(0, 10), filters.range)) continue;
        const staffName = staffNameOf.get(r.staffId);
        if (!staffName) continue;
        rows.push({ id: r.id, kind: 'staffReview', staffName, text: r.text ?? undefined, rating: r.rating, hiddenByBusiness: r.hidden, createdAt: at });
      }
    }

    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const starCountByStaff = new Map<string, number>();
    for (const r of rows) if (r.kind === 'staffStar' && r.staffName) starCountByStaff.set(r.staffName, (starCountByStaff.get(r.staffName) ?? 0) + 1);
    const starSummary = staffAll
      .map((s) => ({ staffId: s.id, staffName: s.name, starsCount: starCountByStaff.get(s.name) ?? 0 }))
      .filter((r) => r.starsCount > 0)
      .sort((a, b) => b.starsCount - a.starsCount);

    const ratingRowsByStaff = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      if (r.kind !== 'staffReview' || !r.staffName || r.rating === undefined) continue;
      const cell = ratingRowsByStaff.get(r.staffName) ?? { sum: 0, count: 0 };
      cell.sum += r.rating;
      cell.count += 1;
      ratingRowsByStaff.set(r.staffName, cell);
    }
    const ratingSummary = staffAll
      .map((s) => {
        const cell = ratingRowsByStaff.get(s.name);
        return { staffId: s.id, staffName: s.name, count: cell?.count ?? 0, avgRating: cell && cell.count ? cell.sum / cell.count : 0 };
      })
      .filter((r) => r.count > 0)
      .sort((a, b) => b.avgRating - a.avgRating);

    return { rows, starSummary, ratingSummary };
  }

  async deleteCompanyReview(businessId: string, reviewId: string) {
    const row = await this.prisma.locationReview.findFirst({ where: { id: reviewId, businessId } });
    if (!row) throw new ApiError('not_found', 'Review not found');
    await this.prisma.locationReview.delete({ where: { id: reviewId } });
  }

  async setStaffReviewHidden(businessId: string, reviewId: string, hidden: boolean) {
    const row = await this.prisma.staffReview.findFirst({ where: { id: reviewId, businessId } });
    if (!row) throw new ApiError('not_found', 'Review not found');
    await this.prisma.staffReview.update({ where: { id: reviewId }, data: { hidden } });
  }
}
