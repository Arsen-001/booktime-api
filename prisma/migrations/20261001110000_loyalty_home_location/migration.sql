-- backend-2, заход 3 (qa/full-test-0930): строки лояльности без формы фронта (сид, маршруты этапа 11) получали
-- в поле формы `locationId` id БИЗНЕСА (port/store.ts подставлял r.businessId), и после первой записи через порт это
-- попадало в `data`. Продажа/пополнение по такому счёту не находили филиал (например, демо-счёт la_biz_nuri).
-- store.ts теперь подставляет первый филиал бизнеса; здесь то же исправление для уже записанных `data`.
-- Только данные, схема не меняется.
UPDATE `client_accounts` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
UPDATE `membership_sales` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
UPDATE `certificates` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
UPDATE `loyalty_tx` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
UPDATE `loyalty_cards` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
UPDATE `loyalty_online_orders` t
SET t.`data` = JSON_SET(t.`data`, '$.locationId', (
  SELECT l.`id` FROM `locations` l WHERE l.`business_id` = t.`business_id` AND l.`deleted_at` IS NULL ORDER BY l.`sort_order`, l.`created_at` LIMIT 1))
WHERE t.`data` IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(t.`data`, '$.locationId')) = t.`business_id`
  AND EXISTS (SELECT 1 FROM `locations` l2 WHERE l2.`business_id` = t.`business_id` AND l2.`deleted_at` IS NULL);
