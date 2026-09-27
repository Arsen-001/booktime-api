-- AlterTable
ALTER TABLE `booking_payments` ADD COLUMN `debt` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `goods` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `group_id` VARCHAR(32) NULL,
    ADD COLUMN `loyalty_account_id` VARCHAR(32) NULL;

-- CreateTable
CREATE TABLE `fin_records` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `ref_id` VARCHAR(32) NULL,
    `client_id` VARCHAR(32) NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `fin_records_business_id_kind_ref_id_idx`(`business_id`, `kind`, `ref_id`),
    INDEX `fin_records_business_id_kind_client_id_idx`(`business_id`, `kind`, `client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
