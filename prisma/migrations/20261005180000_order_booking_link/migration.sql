-- Заказы (05.10.2026): ⭐ запись на сдачу по времени — клиент записывается на «Приём заказа» (скрытая услуга
-- мастерской, kind = 'intake'), при визите мастер одним нажатием принимает заказ по этой записи. Ссылка заказа на
-- запись; уникальна — по одной записи принимают один заказ (повторное нажатие не создаёт второй).
-- AlterTable
ALTER TABLE `orders` ADD COLUMN `booking_id` VARCHAR(32) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `orders_booking_id_key` ON `orders`(`booking_id`);
