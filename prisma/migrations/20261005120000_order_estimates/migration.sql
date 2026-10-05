-- Заказы (05.10.2026): ⭐ смета и согласование цены с клиентом — мастерская после диагностики отправляет смету
-- (работы и запчасти с ценами или одна цена + комментарий), клиент по ссылке /o/<code> отвечает «Согласен» или
-- «Отказаться»; не ответил за сутки — одно напоминание.
-- AlterTable
ALTER TABLE `orders` ADD COLUMN `estimate` JSON NULL,
    ADD COLUMN `estimate_status` VARCHAR(10) NULL,
    ADD COLUMN `estimate_sent_at` DATETIME(3) NULL,
    ADD COLUMN `estimate_reminded_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `orders_estimate_status_estimate_reminded_at_idx` ON `orders`(`estimate_status`, `estimate_reminded_at`);
