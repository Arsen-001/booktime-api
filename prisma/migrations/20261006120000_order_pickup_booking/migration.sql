-- Заказы (06.10.2026): ⭐ выдача по времени — у готового заказа клиент по ссылке /o/<code> выбирает, когда придёт
-- забрать: запись на «Выдача заказа» (скрытая услуга мастерской, kind = 'pickup'). Ссылка заказа на эту запись;
-- уникальна — одна запись принадлежит одному заказу (повтор того же выбора не создаёт вторую).
-- AlterTable
ALTER TABLE `orders` ADD COLUMN `pickup_booking_id` VARCHAR(32) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `orders_pickup_booking_id_key` ON `orders`(`pickup_booking_id`);
