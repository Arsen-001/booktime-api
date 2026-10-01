-- Решение владельца 01.10.2026 (qa/full-test-0930, агент stock): администратор по умолчанию ведёт склад — товары,
-- приход, продажа, списание (stock.edit добавлено в ROLE_PERMISSIONS.admin, src/common/permissions/permissions.ts).
-- Как 20261001100000_admin_default_loyalty_manage: только наборы галочек, которые владелец не менял. После той миграции
-- нетронутый набор = 16 прежних прав + loyalty.manage + finance.shift (18); ему дописываем stock.edit. Идёт строго после
-- неё (порядок имён), поэтому работает и при применении обеих за один deploy. Только данные, схема не меняется.
UPDATE `staff`
SET `permissions` = JSON_ARRAY_APPEND(`permissions`, '$', 'stock.edit')
WHERE `role` = 'admin'
  AND `permissions` IS NOT NULL
  AND JSON_LENGTH(`permissions`) = 18
  AND JSON_CONTAINS(`permissions`, '["journal.view","journal.edit","journal.create","journal.reschedule","journal.others","journal.stats","clients.view","clients.phones","clients.edit","schedule.edit","services.view","staff.view","online.manage","online.own","stock.view","resources.manage","loyalty.manage","finance.shift"]');
