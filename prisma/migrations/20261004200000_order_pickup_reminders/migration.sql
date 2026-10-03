-- Заказы (04.10.2026): напоминание клиенту, что готовый заказ ждёт его — через 3 и 7 дней после «Готов»
-- (настройка бизнеса: off | 3 | 3_7, null — по умолчанию 3_7); счётчик и время последнего напоминания у заказа.
-- AlterTable
ALTER TABLE `businesses` ADD COLUMN `order_pickup_reminders` VARCHAR(8) NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `pickup_reminder_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `pickup_reminded_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `orders_status_pickup_reminder_count_idx` ON `orders`(`status`, `pickup_reminder_count`);
