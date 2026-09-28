/**
 * Запускается tsx'ом с tsconfig ФРОНТА (prisma/seed/mock-core.ts): печатает в stdout JSON демо-ядра мока
 * (booking-platform/src/mock/seed) — чтобы сид сервера строил те же бизнесы, людей и записи, что демо фронта.
 * С этапа 6 рядом кладётся срез раздела «schedule» (шаблоны, история, правила слотов, настройки) — `areaSchedule`.
 */
// @ts-expect-error — путь из tsconfig фронта, в сборке сервера не участвует
import { seedCore } from '@/mock/seed';
// @ts-expect-error — путь из tsconfig фронта
import { scheduleSlice } from '@/mock/slices/schedule';
// @ts-expect-error — путь из tsconfig фронта (этап 21, лейн loyalty: срез «loyalty» — карты, акции, сертификаты, абонементы, счета)
import { loyaltySlice } from '@/mock/slices/loyalty';
// @ts-expect-error — путь из tsconfig фронта (этап 21, лейн finance+stock: политика оплаты, Adyen, ссылки, заказы, настройки)
import { financeSlice } from '@/mock/slices/finance';
// @ts-expect-error — путь из tsconfig фронта (этап 21, сдача, попытка 6: маркетплейс интеграций — каталог, отзывы, промоблоки, демо-подключения)
import { integrationsSlice } from '@/mock/slices/integrations';
// @ts-expect-error — путь из tsconfig фронта (этап 21, сдача, попытка 6: сторис, новости, продвижение кабинета)
import { clientSlice } from '@/mock/slices/client';

/** Из среза «client» серверу нужны только сторис/новости/продвижение (остальное сеют свои этапы) */
function pickClientPromo(state: { stories: unknown[]; newsPosts: unknown[]; promotionSettings: unknown }) {
  return { stories: state.stories, newsPosts: state.newsPosts, promotionSettings: state.promotionSettings };
}

const now = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date();
const core = seedCore(now);
process.stdout.write(JSON.stringify({ ...core, areaSchedule: scheduleSlice.seed(core, now), areaLoyalty: loyaltySlice.seed(core, now), areaFinance: financeSlice.seed(core, now), areaIntegrations: integrationsSlice.seed(core, now), areaClientPromo: pickClientPromo(clientSlice.seed(core, now)) }));
