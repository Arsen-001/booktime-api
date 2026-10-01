-- Решение владельца 01.10.2026: мастер по умолчанию видит только свою зарплату — payroll.view убрано из
-- ROLE_PERMISSIONS.master (src/common/permissions/permissions.ts; во фронте — config/permissions.ts, roleDefaults.ts).
-- Сервер берёт права мастера из шаблона роли (сохранённый набор заменяет шаблон только у администратора,
-- effectivePermissions), поэтому новый шаблон действует сразу. Здесь — на случай сохранённых наборов: у мастеров с
-- нетронутым прежним шаблоном (10 прав, владелец их не менял) снимаем payroll.view; изменённые владельцем не трогаем.
-- Мастеров миграции 20261001100000/20261001140000 не касаются (только role = 'admin'), порядок не важен.
-- В дев-базе на 01.10.2026 сохранённых наборов у мастеров нет (0 из 28). Только данные, схема не меняется.
UPDATE `staff`
SET `permissions` = JSON_REMOVE(`permissions`, JSON_UNQUOTE(JSON_SEARCH(`permissions`, 'one', 'payroll.view')))
WHERE `role` = 'master'
  AND `permissions` IS NOT NULL
  AND JSON_LENGTH(`permissions`) = 10
  AND JSON_CONTAINS(`permissions`, '["journal.view","journal.edit","journal.create","journal.reschedule","clients.view","schedule.edit","services.view","stock.view","payroll.view","online.own"]');
