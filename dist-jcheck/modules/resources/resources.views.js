const arr = (v) => (Array.isArray(v) ? v : []);
export function resourceView(r) {
    return {
        id: r.id,
        businessId: r.businessId,
        locationId: r.locationId,
        name: r.name,
        kind: r.kind,
        instances: arr(r.instances),
        serviceIds: arr(r.serviceIds),
        active: r.active,
        description: r.description ?? '',
        version: r.version,
    };
}
//# sourceMappingURL=resources.views.js.map