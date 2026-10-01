-- Один лист ожидания бизнеса (владелец, 30.09.2026).
-- Было две таблицы: waitlist_entries (панель журнала + приложение + раздача окна В-18, желания — «slots») и
-- resources_waitlist_entries (экран /biz/waitlist, желания — «wishes», теги, история отметок «Уведомлён»).
-- Канонической остаётся waitlist_entries (на неё уже смотрят FreedSlot.waitlist_ids, приложение клиента, склейка
-- клиентов, обезличивание): она получает форму «wishes» + tags + notified_times, строки второй таблицы
-- переезжают в неё с теми же id (ссылки аудита сохраняются), вторая таблица удаляется.

-- 1. Новые колонки (пока NULL — заполняем ниже)
ALTER TABLE `waitlist_entries`
    ADD COLUMN `wishes` JSON NULL,
    ADD COLUMN `tags` JSON NULL,
    ADD COLUMN `notified_times` JSON NULL;

-- 2. slots → wishes:
--    { date, anyTime: true }                  → { date }
--    { date, anyTime: false, intervals: [..] } → { date, time: intervals[0].from, intervals }
--    { anyTime: false, intervals: [..] }       → { time, intervals }   (любой день, но в эти часы)
--    { anyTime: true } без даты                → не хранится: пустой список = «ждёт когда угодно»
UPDATE `waitlist_entries` w
SET w.`wishes` = (
    SELECT COALESCE(JSON_ARRAYAGG(x.`wish`), JSON_ARRAY())
    FROM (
        SELECT CAST(
            CASE
                WHEN s.`timed` = 0 THEN JSON_OBJECT('date', s.`d`)
                WHEN s.`d` IS NULL THEN JSON_OBJECT('time', s.`t`, 'intervals', s.`iv`)
                ELSE JSON_OBJECT('date', s.`d`, 'time', s.`t`, 'intervals', s.`iv`)
            END AS JSON) AS `wish`
        FROM (
            SELECT
                NULLIF(JSON_UNQUOTE(JSON_EXTRACT(jt.`slot`, '$.date')), 'null') AS `d`,
                (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(jt.`slot`, '$.anyTime')), 'true') <> 'true'
                    AND COALESCE(JSON_LENGTH(JSON_EXTRACT(jt.`slot`, '$.intervals')), 0) > 0) AS `timed`,
                JSON_EXTRACT(jt.`slot`, '$.intervals') AS `iv`,
                JSON_UNQUOTE(JSON_EXTRACT(jt.`slot`, '$.intervals[0].from')) AS `t`
            FROM JSON_TABLE(w.`slots`, '$[*]' COLUMNS (`slot` JSON PATH '$')) AS jt
        ) AS s
        WHERE s.`d` IS NOT NULL OR s.`timed` = 1
    ) AS x
);
UPDATE `waitlist_entries` SET `wishes` = JSON_ARRAY() WHERE `wishes` IS NULL;
UPDATE `waitlist_entries` SET `tags` = JSON_ARRAY() WHERE `tags` IS NULL;
-- Прошлая одиночная отметка раздачи окна — первой строкой истории «Уведомлён»
UPDATE `waitlist_entries`
SET `notified_times` = JSON_ARRAY(DATE_FORMAT(`notified_at`, '%Y-%m-%dT%H:%i:%s.000Z'))
WHERE `notified_at` IS NOT NULL;

-- slots переведены — колонка больше не нужна (и не мешает вставке ниже)
ALTER TABLE `waitlist_entries` DROP COLUMN `slots`;

-- 3. Строки экрана /biz/waitlist → в общую таблицу (id те же; при невероятном совпадении id — с суффиксом)
INSERT INTO `waitlist_entries` (
    `id`, `business_id`, `location_id`, `client_name`, `client_phone`, `client_id`, `app_user_id`,
    `service_ids`, `staff_ids`, `wishes`, `comment`, `tags`, `booking_id`, `notified_at`, `notified_times`,
    `created_at`, `updated_at`, `created_by`, `version`
)
SELECT
    IF(EXISTS (SELECT 1 FROM `waitlist_entries` e WHERE e.`id` = r.`id`), CONCAT(LEFT(r.`id`, 29), '_rw'), r.`id`),
    r.`business_id`,
    r.`location_id`,
    r.`client_name`,
    r.`client_phone`,
    (SELECT c.`id` FROM `clients` c
        WHERE c.`business_id` = r.`business_id` AND c.`phone` = r.`client_phone` AND c.`deleted_at` IS NULL
        LIMIT 1),
    NULL,
    r.`service_ids`,
    r.`staff_ids`,
    r.`wishes`,
    r.`comment`,
    r.`tags`,
    r.`closed_booking_id`,
    IF(COALESCE(JSON_LENGTH(r.`notified_times`), 0) > 0,
        STR_TO_DATE(LEFT(JSON_UNQUOTE(JSON_EXTRACT(r.`notified_times`, '$[last]')), 23), '%Y-%m-%dT%H:%i:%s.%f'),
        NULL),
    r.`notified_times`,
    r.`created_at`,
    r.`created_at`,
    r.`created_by`,
    1
FROM `resources_waitlist_entries` r;

-- 4. Форма окончательная: желания и теги обязательны
ALTER TABLE `waitlist_entries`
    MODIFY `wishes` JSON NOT NULL,
    MODIFY `tags` JSON NOT NULL;

-- 5. Вторая таблица больше не нужна
DROP TABLE `resources_waitlist_entries`;
