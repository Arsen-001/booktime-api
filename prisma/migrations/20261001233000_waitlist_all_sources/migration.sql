-- Один лист ожидания бизнеса — и для всех входов (владелец, 30.09.2026; доделка 01.10.2026).
-- В waitlist_entries уже пишут экран /biz/waitlist, панель журнала и приложение клиента (/v1/me/waitlist).
-- Виджет онлайн-записи («Встать в лист ожидания», /v1/public/businesses/{b}/waitlist) писал отдельно —
-- в online_records kind='waitlist'. Теперь и он пишет в waitlist_entries; старые заявки виджета переезжают сюда.

-- 1. Откуда заявка: staff | app | widget
ALTER TABLE `waitlist_entries`
    ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'staff';

UPDATE `waitlist_entries` SET `source` = 'app' WHERE `app_user_id` IS NOT NULL;

-- 2. Заявки виджета → в общий лист (id те же; при невероятном совпадении id — с суффиксом).
--    data: { locationId?, staffId, serviceId, date, clientName, clientPhone, comment?, status }
--    Отменённые и уже записанные (status cancelled/booked, ссылки на запись у них нет) не переносим.
--    «Уведомлён» (status notified) — первой отметкой истории, временем последнего изменения строки.
INSERT INTO `waitlist_entries` (
    `id`, `business_id`, `location_id`, `client_name`, `client_phone`, `client_id`, `app_user_id`, `source`,
    `service_ids`, `staff_ids`, `wishes`, `comment`, `tags`, `booking_id`, `notified_at`, `notified_times`,
    `created_at`, `updated_at`, `created_by`, `version`
)
SELECT
    IF(EXISTS (SELECT 1 FROM `waitlist_entries` e WHERE e.`id` = o.`id`), CONCAT(LEFT(o.`id`, 29), '_ow'), o.`id`),
    o.`business_id`,
    NULLIF(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.locationId')), 'null'),
    LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.clientName')), ''), 160),
    LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.clientPhone')), ''), 20),
    (SELECT c.`id` FROM `clients` c
        WHERE c.`business_id` = o.`business_id`
          AND c.`phone` = JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.clientPhone'))
          AND c.`deleted_at` IS NULL
        LIMIT 1),
    NULL,
    'widget',
    JSON_ARRAY(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.serviceId'))),
    JSON_ARRAY(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.staffId'))),
    IF(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.date')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        JSON_ARRAY(JSON_OBJECT('date', JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.date')))),
        JSON_ARRAY()),
    LEFT(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.comment')), 'null'), ''), 2000),
    JSON_ARRAY(),
    NULL,
    IF(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.status')) = 'notified', o.`updated_at`, NULL),
    IF(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.status')) = 'notified',
        JSON_ARRAY(DATE_FORMAT(o.`updated_at`, '%Y-%m-%dT%H:%i:%s.000Z')),
        NULL),
    o.`created_at`,
    o.`updated_at`,
    NULL,
    1
FROM `online_records` o
WHERE o.`kind` = 'waitlist'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.status')), 'pending') NOT IN ('cancelled', 'booked')
  AND JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.serviceId')) IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(o.`data`, '$.staffId')) IS NOT NULL;

-- 3. Старые строки виджета больше не нужны
DELETE FROM `online_records` WHERE `kind` = 'waitlist';
