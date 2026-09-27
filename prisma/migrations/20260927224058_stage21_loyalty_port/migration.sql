-- DropIndex
DROP INDEX `certificates_code_key` ON `certificates`;

-- DropIndex
DROP INDEX `membership_sales_code_key` ON `membership_sales`;

-- AlterTable
ALTER TABLE `certificate_types` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `certificates` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `client_account_ops` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `client_account_types` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `client_accounts` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `loyalty_card_types` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `loyalty_cards` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `loyalty_tx` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `membership_sales` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `membership_types` ADD COLUMN `data` JSON NULL;

-- AlterTable
ALTER TABLE `promotions` ADD COLUMN `data` JSON NULL;

-- CreateTable
CREATE TABLE `loyalty_online_orders` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `loyalty_online_orders_business_id_created_at_idx`(`business_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `certificates_business_id_code_key` ON `certificates`(`business_id`, `code`);

-- CreateIndex
CREATE UNIQUE INDEX `membership_sales_business_id_code_key` ON `membership_sales`(`business_id`, `code`);
