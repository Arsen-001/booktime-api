-- Решения владельца 01.10.2026 (qa/full-test-0930): администратор по умолчанию продаёт абонементы и сертификаты
-- (loyalty.manage) и ведёт кассовую смену (finance.shift) — оба права добавлены в ROLE_PERMISSIONS.admin
-- (src/common/permissions/permissions.ts). Администратор с сохранённым набором галочек (staff.permissions заменяет
-- шаблон, effectivePermissions) новых прав шаблона не получает. Здесь — только те наборы, что в точности равны
-- прежнему шаблону администратора (16 прав, владелец их не менял): им дописываем два новых права. Наборы,
-- изменённые владельцем, не трогаем. Только данные, схема не меняется.
UPDATE `staff`
SET `permissions` = JSON_ARRAY_APPEND(JSON_ARRAY_APPEND(`permissions`, '$', 'loyalty.manage'), '$', 'finance.shift')
WHERE `role` = 'admin'
  AND `permissions` IS NOT NULL
  AND JSON_LENGTH(`permissions`) = 16
  AND JSON_CONTAINS(`permissions`, '["journal.view","journal.edit","journal.create","journal.reschedule","journal.others","journal.stats","clients.view","clients.phones","clients.edit","schedule.edit","services.view","staff.view","online.manage","online.own","stock.view","resources.manage"]');
