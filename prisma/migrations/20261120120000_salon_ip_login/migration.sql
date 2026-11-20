-- «Вход только с IP салона» по-настоящему (20.11.2026, DESIGN.md сайта ответ 22, ROADMAP «Скрыто… — вернуть»).
-- Было: у сотрудника свой список масок staff.ip_restriction { enabled, ranges[] }, сервер его не проверял вовсе, на сайте
-- переключатель спрятан с 17.11 (подписан «Демо»). Стало: список адресов — у салона (businesses.salon_ips), у сотрудника —
-- галочка staff.salon_ip_only; проверка на каждом запросе кабинета (common/http/membership.ts). Попытки не с адреса салона —
-- salon_ip_attempts (одна строка на сотрудника и адрес), владелец добавляет адрес одной кнопкой.
-- Перенос: адреса из прежних списков сотрудников складываются в список их салона (без повторов); галочки не переносятся —
-- прежний переключатель был демо и ничего не закрывал, включить по-настоящему — решение владельца в карточке сотрудника.
-- Пример: у Ани ranges ['37.252.64.10'], у Мариам ['37.252.64.10', '5.77.0.0/16'] → у салона ['37.252.64.10', '5.77.0.0/16'],
-- у обеих salon_ip_only = 0. Повторный запуск ничего не делает: каждый шаг — только если его ещё не было.

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'businesses' AND column_name = 'salon_ips');
SET @ddl := IF(@has_col = 0, 'ALTER TABLE `businesses` ADD COLUMN `salon_ips` JSON NULL', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'staff' AND column_name = 'salon_ip_only');
SET @ddl := IF(@has_col = 0, 'ALTER TABLE `staff` ADD COLUMN `salon_ip_only` BOOLEAN NOT NULL DEFAULT false', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

CREATE TABLE IF NOT EXISTS `salon_ip_attempts` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `ip` VARCHAR(64) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 1,
    `first_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `salon_ip_attempts_business_id_staff_id_ip_key`(`business_id`, `staff_id`, `ip`),
    INDEX `salon_ip_attempts_business_id_last_at_idx`(`business_id`, `last_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Адреса прежних списков сотрудников → список салона (только там, где у салона списка ещё нет)
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'staff' AND column_name = 'ip_restriction');
SET @dml := IF(@has_col = 1,
  "UPDATE `businesses` b JOIN (
     SELECT x.business_id, JSON_ARRAYAGG(x.r) AS ips FROM (
       SELECT DISTINCT s.business_id, TRIM(jt.r) AS r
       FROM `staff` s, JSON_TABLE(s.ip_restriction, '$.ranges[*]' COLUMNS (r VARCHAR(64) PATH '$')) jt
       WHERE s.ip_restriction IS NOT NULL AND s.deleted_at IS NULL AND jt.r IS NOT NULL AND TRIM(jt.r) <> ''
     ) x GROUP BY x.business_id
   ) t ON t.business_id = b.id
   SET b.salon_ips = t.ips
   WHERE b.salon_ips IS NULL",
  'DO 0');
PREPARE mig_stmt FROM @dml;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SET @ddl := IF(@has_col = 1, 'ALTER TABLE `staff` DROP COLUMN `ip_restriction`', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;
