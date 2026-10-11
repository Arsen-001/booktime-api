-- График (11.10.2026): Г16 — заметка дня (название «Выходного салона», комментарий к отсутствию); Г10 — свои часы на
-- дни недели в шаблоне графика. Только новые NULL-колонки: старые строки не меняются.
-- AlterTable
ALTER TABLE `staff_day_types` ADD COLUMN `note` VARCHAR(120) NULL;

-- AlterTable
ALTER TABLE `schedule_templates` ADD COLUMN `weekday_hours` JSON NULL;
