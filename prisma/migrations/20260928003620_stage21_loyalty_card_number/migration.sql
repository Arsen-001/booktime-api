-- DropIndex
DROP INDEX `loyalty_cards_number_key` ON `loyalty_cards`;

-- CreateIndex
CREATE UNIQUE INDEX `loyalty_cards_business_id_number_key` ON `loyalty_cards`(`business_id`, `number`);

