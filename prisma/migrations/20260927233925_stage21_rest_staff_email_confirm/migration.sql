-- AlterTable
ALTER TABLE `booking_payments` ADD COLUMN `refunded_amount` BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `online_records` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `link_id` VARCHAR(32) NULL,
    `ref_id` VARCHAR(32) NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `online_records_business_id_kind_idx`(`business_id`, `kind`),
    INDEX `online_records_link_id_kind_idx`(`link_id`, `kind`),
    INDEX `online_records_ref_id_kind_idx`(`ref_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_shifts` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `account_id` VARCHAR(32) NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `open_key` VARCHAR(32) NULL,
    `opened_at` DATETIME(3) NOT NULL,
    `opened_by` VARCHAR(32) NOT NULL,
    `opening_cash` BIGINT NOT NULL,
    `expected_at_open` BIGINT NOT NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by` VARCHAR(32) NULL,
    `counted_cash` BIGINT NULL,
    `expected_at_close` BIGINT NULL,
    `adjustment_operation_ids` JSON NOT NULL,
    `comment` VARCHAR(500) NULL,

    UNIQUE INDEX `cash_shifts_open_key_key`(`open_key`),
    INDEX `cash_shifts_business_id_account_id_opened_at_idx`(`business_id`, `account_id`, `opened_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
