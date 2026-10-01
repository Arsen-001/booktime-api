-- Лента изменений журнала за день (⭐ рабочий день №12, GET /v1/biz/{b}/journal/day-feed): оплаты и отмены оплат
-- визитов за день выбираются по бизнесу и времени — без этих индексов запрос перебирал бы все платежи бизнеса.
-- Только индексы, данные не меняются; код работает и до применения (медленнее на больших базах).
CREATE INDEX `booking_payments_business_id_created_at_idx` ON `booking_payments`(`business_id`, `created_at`);
CREATE INDEX `booking_payments_business_id_cancelled_at_idx` ON `booking_payments`(`business_id`, `cancelled_at`);
