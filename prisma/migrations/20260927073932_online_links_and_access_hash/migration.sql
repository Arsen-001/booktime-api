-- AlterTable
ALTER TABLE `bookings` ADD COLUMN `access_hash` CHAR(64) NULL,
    ADD COLUMN `access_hash_expires_at` DATETIME(3) NULL,
    ADD COLUMN `online_meta` JSON NULL;

-- CreateTable
CREATE TABLE `booking_links` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `network_id` VARCHAR(32) NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` VARCHAR(2000) NULL,
    `kind` VARCHAR(8) NOT NULL,
    `booking_type` VARCHAR(10) NOT NULL,
    `default_locale` VARCHAR(2) NOT NULL,
    `staff_id` VARCHAR(32) NULL,
    `primary` BOOLEAN NOT NULL DEFAULT false,
    `form_id` VARCHAR(20) NOT NULL,
    `config` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `booking_links_business_id_idx`(`business_id`),
    UNIQUE INDEX `booking_links_business_id_form_id_key`(`business_id`, `form_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `bookings_access_hash_key` ON `bookings`(`access_hash`);

