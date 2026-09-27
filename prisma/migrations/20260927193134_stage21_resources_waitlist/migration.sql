/*
  Warnings:

  - You are about to drop the column `notified_times` on the `waitlist_entries` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `waitlist_entries` DROP COLUMN `notified_times`;

-- CreateTable
CREATE TABLE `resources_waitlist_entries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `client_name` VARCHAR(160) NOT NULL,
    `client_phone` VARCHAR(20) NOT NULL,
    `service_ids` JSON NOT NULL,
    `staff_ids` JSON NOT NULL,
    `wishes` JSON NOT NULL,
    `comment` VARCHAR(2000) NOT NULL DEFAULT '',
    `tags` JSON NOT NULL,
    `closed_booking_id` VARCHAR(32) NULL,
    `notified_times` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `resources_waitlist_entries_business_id_created_at_idx`(`business_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
