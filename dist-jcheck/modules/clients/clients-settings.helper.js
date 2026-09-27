export function defaultClientsBizSettings() {
    return { autoSaveChatLeads: false, lostAfterDays: 60, showFullNameFields: true, customFieldDefs: [], showLoyaltySearchInBookingWindow: false };
}
const AREA = 'clients';
export async function getClientsBizSettings(prisma, businessId) {
    const row = await prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    return { ...defaultClientsBizSettings(), ...(row?.data ?? {}) };
}
export async function patchClientsBizSettings(prisma, businessId, patch) {
    const current = await getClientsBizSettings(prisma, businessId);
    const next = { ...current, ...patch };
    await prisma.businessSetting.upsert({
        where: { businessId_area: { businessId, area: AREA } },
        create: { businessId, area: AREA, data: next },
        update: { data: next, version: { increment: 1 } },
    });
    return next;
}
//# sourceMappingURL=clients-settings.helper.js.map