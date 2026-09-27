import { createPushSenders } from '../adapters/push/push.js';
import { NotifyDispatchService } from '../modules/notify/notify-dispatch.service.js';
/** Собранный без Nest, как journalServices() (jobs/journal-jobs.ts) — тот же приём для воркера (PLAN.md Р10) */
export function notifyServices(prisma) {
    const dispatch = new NotifyDispatchService(prisma, createPushSenders());
    return { dispatch };
}
//# sourceMappingURL=notify-jobs.js.map