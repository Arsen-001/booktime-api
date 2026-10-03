/**
 * Общее для тестов входа (google-login.test.ts, apple-login.test.ts): база в памяти — ровно то подмножество Prisma,
 * которым пользуются вход по коду и внешние входы. Файл назван *.test.ts, чтобы не попадать в сборку; тестов в нём нет.
 */
export type Row = Record<string, unknown> & { id: string };

export function memoryDb() {
  const users: Row[] = [];
  const profiles: Row[] = [];
  const identities: Row[] = [];
  const sessions: Row[] = [];
  const events: Row[] = [];
  const audit: Row[] = [];
  const withProfile = (u: Row | undefined) => (u ? { ...u, appProfile: profiles.find((p) => p.userId === u.id) ?? null } : null);
  const idMatch = (r: Row, w: Record<string, unknown>) => {
    if (w.provider_subject) {
      const ps = w.provider_subject as { provider: string; subject: string };
      return r.provider === ps.provider && r.subject === ps.subject;
    }
    return Object.entries(w).every(([k, v]) => r[k] === v);
  };
  const db = {
    users,
    identities,
    sessions,
    events,
    audit,
    user: {
      findUnique: async ({ where }: { where: { phone?: string; id?: string } }) =>
        withProfile(users.find((u) => (where.phone ? u.phone === where.phone : u.id === where.id))),
      create: async ({ data }: { data: Row }) => {
        const u = { blockedAt: null, deletedAt: null, locale: 'ru', ...data };
        users.push(u);
        return u;
      },
    },
    appProfile: {
      upsert: async ({ where, create, update }: { where: { userId: string }; create: Row; update: Row }) => {
        const p = profiles.find((x) => x.userId === where.userId);
        if (p) return Object.assign(p, update);
        profiles.push({ ...create, id: where.userId });
        return create;
      },
    },
    staff: { findFirst: async () => null },
    loginEvent: { create: async ({ data }: { data: Row }) => events.push(data) },
    auditEvent: { create: async ({ data }: { data: Row }) => audit.push(data) },
    userIdentity: {
      findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
        const r = identities.find((x) => idMatch(x, where));
        if (!r) return null;
        return include ? { ...r, user: withProfile(users.find((u) => u.id === r.userId)) } : r;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => identities.find((x) => idMatch(x, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        if (identities.some((x) => x.provider === data.provider && x.subject === data.subject)) throw new Error('P2002');
        identities.push({ ...data });
        return data;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(identities.find((x) => x.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => identities.splice(identities.findIndex((x) => x.id === where.id), 1)[0],
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (let i = identities.length - 1; i >= 0; i--) if (idMatch(identities[i]!, where)) (identities.splice(i, 1), count++);
        return { count };
      },
    },
    session: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const s = sessions.find((x) => x.id === where.id)!;
        return { ...s, user: withProfile(users.find((u) => u.id === s.userId)), staffLogin: null };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}
