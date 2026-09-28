-- CreateTable
CREATE TABLE `visit_cash_records` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `data` JSON NOT NULL,
    `refunded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `visit_cash_records_booking_id_kind_idx`(`booking_id`, `kind`),
    INDEX `visit_cash_records_business_id_kind_idx`(`business_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
