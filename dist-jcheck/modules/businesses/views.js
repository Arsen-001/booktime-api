import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const opt = (v) => (v === null || v === undefined ? undefined : v);
export function businessView(b, locationIds) {
    return {
        id: b.id,
        kind: b.kind,
        name: b.name,
        slug: b.slug,
        sphereIds: arr(b.sphereIds),
        networkId: opt(b.networkId),
        ownerStaffId: b.ownerStaffId ?? '',
        locationIds,
        phone: b.phone,
        description: opt(b.description),
        logoUrl: opt(b.logoUrl),
        photos: arr(b.photos),
        status: b.status,
        createdAt: utcToLocal(b.createdAt),
        forbidHomeBookingsDuringShift: b.forbidHomeBookingsDuringShift,
        socials: opt(b.socials),
        bookingRules: opt(b.bookingRules),
        brandName: opt(b.brandName),
        version: b.version,
    };
}
export function locationView(l) {
    return {
        id: l.id,
        businessId: l.businessId,
        name: l.name,
        address: l.address,
        district: l.district,
        yandexMapsUrl: opt(l.yandexMapsUrl),
        coords: l.lat !== null && l.lng !== null ? { lat: Number(l.lat), lng: Number(l.lng) } : undefined,
        phone: opt(l.phone),
        extraPhones: opt(l.extraPhones),
        hoursText: opt(l.hoursText),
        openHours: opt(l.openHours),
        journalKind: opt(l.journalKind),
        timezone: l.tz,
        version: l.version,
    };
}
export function networkView(n, businessIds) {
    return {
        id: n.id,
        name: n.name,
        ownerStaffId: n.ownerStaffId ?? '',
        businessIds,
        createdAt: utcToLocal(n.createdAt),
        mainBusinessId: opt(n.mainBusinessId),
        version: n.version,
    };
}
export function staffView(s) {
    return {
        id: s.id,
        businessId: s.businessId,
        locationIds: (s.locations ?? []).map((l) => l.locationId),
        name: s.name,
        phone: s.phone,
        email: opt(s.email),
        role: s.role,
        position: opt(s.position),
        specialty: opt(s.specialty),
        sphereIds: arr(s.sphereIds),
        avatarUrl: opt(s.avatarUrl),
        bio: opt(s.bio),
        photos: arr(s.photos),
        materials: arr(s.materials),
        workplaces: arr(s.workplaces),
        homeAddress: opt(s.homeAddress),
        homeDistrict: opt(s.homeDistrict),
        visitDistricts: opt(s.visitDistricts),
        accepts: s.accepts,
        calendarVisibility: s.calendarVisibility,
        calendarMode: s.calendarMode,
        confirmMode: s.confirmMode,
        colorIndex: s.colorIndex,
        serviceIds: arr(s.serviceIds),
        status: s.status,
        /** Логин администратора (F-00-034) — из staff_logins */
        login: undefined,
        callHours: opt(s.callHours),
        hiredAt: s.hiredAt,
        onlineBookingEnabled: s.onlineBookingEnabled,
        hiddenInJournal: s.hiddenInJournal || undefined,
        assistantOnly: s.assistantOnly || undefined,
        journalMarkupMin: opt(s.journalMarkupMin),
        prepayment: opt(s.prepayment),
        bookingRules: opt(s.bookingRules),
        contacts: opt(s.contacts),
        version: s.version,
    };
}
export function staffViewWithLogin(s) {
    const v = staffView(s);
    const login = s.logins?.find((l) => !l.disabledAt)?.login;
    return login ? { ...v, login } : v;
}
export function positionView(p) {
    return {
        id: p.id,
        businessId: p.businessId ?? '',
        name: p.name,
        description: opt(p.description),
        order: p.sortOrder,
        createdAt: utcToLocalDate(p.createdAt),
    };
}
export function inviteView(i) {
    return {
        id: i.id,
        businessId: i.businessId,
        staffId: i.staffId,
        role: i.role,
        phone: opt(i.phone),
        email: opt(i.email),
        // Во фронте три состояния; «отклонено» и «истекло» экран показывает как отозванное
        status: (i.status === 'pending' || i.status === 'accepted' ? i.status : 'revoked'),
        createdAt: utcToLocalDate(i.sentAt),
    };
}
/** Доступ сотрудника (StaffAccessInfo фронта) */
export function accessView(s) {
    return {
        enabled: s.role === 'owner' ? true : s.accessEnabled,
        info: opt(s.accessInfo),
        roleTemplateId: (s.roleTemplateId ?? defaultRoleTemplate(s.role)),
        ipRestriction: opt(s.ipRestriction),
    };
}
export function defaultRoleTemplate(role) {
    if (role === 'owner')
        return 'owner';
    if (role === 'admin')
        return 'admin';
    return 'specialist';
}
//# sourceMappingURL=views.js.map