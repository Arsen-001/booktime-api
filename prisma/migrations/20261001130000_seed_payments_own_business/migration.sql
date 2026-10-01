-- backend-2, заход 4 (qa/full-test-0930): демо-сид (prisma/seed.ts, «одна реальная оплата визита на бизнес») брал
-- визит из экспорта мока по businessId мока, а в базе этот визит принадлежал ДРУГОМУ бизнесу. Оплата легла в кассу
-- не того бизнеса (например, приходы biz_nuri с филиалом loc_kaytsak). Сид исправлен; здесь — перенос уже
-- записанных оплат к бизнесу самого визита: бизнес, филиал, наличная касса филиала визита, статья «Оплата услуги»
-- этого бизнеса. Только строки сида (created_by = 'seed'), только данные.
UPDATE `fin_ops` o
JOIN `bookings` b ON b.`id` = o.`ref_id`
SET o.`account_id` = COALESCE((SELECT r.`id` FROM `cash_registers` r WHERE r.`location_id` = b.`location_id` AND r.`kind` = 'cash' ORDER BY r.`order` LIMIT 1), o.`account_id`),
    o.`item_id` = COALESCE((SELECT i.`id` FROM `payment_items` i WHERE i.`business_id` = b.`business_id` AND i.`system_key` = 'servicePayment' LIMIT 1), o.`item_id`),
    o.`location_id` = b.`location_id`,
    o.`business_id` = b.`business_id`
WHERE o.`created_by` = 'seed' AND o.`source` = 'booking' AND o.`business_id` <> b.`business_id`;

UPDATE `booking_payments` p
JOIN `bookings` b ON b.`id` = p.`booking_id`
SET p.`account_id` = COALESCE((SELECT r.`id` FROM `cash_registers` r WHERE r.`location_id` = b.`location_id` AND r.`kind` = 'cash' ORDER BY r.`order` LIMIT 1), p.`account_id`),
    p.`business_id` = b.`business_id`
WHERE p.`created_by` = 'seed' AND p.`business_id` <> b.`business_id`;
