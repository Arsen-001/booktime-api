-- «Места» (03.10.2026): база заведений Еревана для отдела продаж + связь визита с местом
-- AlterTable
ALTER TABLE `sales_visits` ADD COLUMN `prospect_id` VARCHAR(32) NULL;

-- CreateTable
CREATE TABLE `prospects` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `category` VARCHAR(16) NOT NULL DEFAULT 'other',
    `district` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `address` VARCHAR(300) NULL,
    `branches` INTEGER NULL,
    `staff_estimate` INTEGER NULL,
    `staff_source` VARCHAR(300) NULL,
    `booking_system` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `booking_url` VARCHAR(500) NULL,
    `website` VARCHAR(500) NULL,
    `instagram` VARCHAR(500) NULL,
    `phone` VARCHAR(40) NULL,
    `reviews` JSON NULL,
    `source_urls` JSON NOT NULL,
    `note` VARCHAR(2000) NULL,
    `tags` JSON NULL,
    `dedup_key` VARCHAR(255) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `prospects_dedup_key_key`(`dedup_key`),
    INDEX `prospects_booking_system_idx`(`booking_system`),
    INDEX `prospects_category_idx`(`category`),
    INDEX `prospects_district_idx`(`district`),
    INDEX `prospects_staff_estimate_idx`(`staff_estimate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `sales_visits_prospect_id_idx` ON `sales_visits`(`prospect_id`);

