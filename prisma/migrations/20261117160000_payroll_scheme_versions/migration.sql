-- Версии схемы зарплаты по датам (З6) и «Период закрыт по» (З11) — как мок сайта (src/domain/payroll.ts:
-- applySchemeVersion, schemeAtDate). Было: сервер хранил одну схему и при сохранении отбрасывал историю, поэтому после
-- смены ставки ведомость и «Расчёт за период» за прошлые дни считались по новой ставке. Пример: до 15.11 у мастера
-- 35 %, с 15.11 — 40 % → за 01–14.11 по 35 %, за 15–17.11 по 40 %.
-- Перенос: нынешнее содержимое каждой схемы остаётся её версией, действующей с самого начала (effective_from = NULL,
-- прежних версий нет — history = NULL), поэтому суммы прошлых периодов не меняются. «Закрыть период» раньше на
-- сервере не сохранялся вовсе: closed_through = NULL — ничего не закрыто.
-- Повторный запуск ничего не делает: каждая колонка добавляется, только если её ещё нет.

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payroll_schemes' AND column_name = 'effective_from');
SET @ddl := IF(@has_col = 0, 'ALTER TABLE `payroll_schemes` ADD COLUMN `effective_from` VARCHAR(10) NULL', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payroll_schemes' AND column_name = 'history');
SET @ddl := IF(@has_col = 0, 'ALTER TABLE `payroll_schemes` ADD COLUMN `history` JSON NULL', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payroll_settings' AND column_name = 'closed_through');
SET @ddl := IF(@has_col = 0, 'ALTER TABLE `payroll_settings` ADD COLUMN `closed_through` VARCHAR(10) NULL', 'DO 0');
PREPARE mig_stmt FROM @ddl;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;
