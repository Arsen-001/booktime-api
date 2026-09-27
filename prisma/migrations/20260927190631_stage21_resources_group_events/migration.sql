-- AlterTable
ALTER TABLE `group_events` ADD COLUMN `extras` JSON NULL;

-- AlterTable
ALTER TABLE `waitlist_entries` ADD COLUMN `notified_times` JSON NULL;

-- CreateTable
CREATE TABLE `event_series_defs` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `service_id` VARCHAR(32) NOT NULL,
    `capacity` INTEGER NOT NULL,
    `days` JSON NOT NULL,
    `end_date` VARCHAR(10) NOT NULL,
    `source_event_id` VARCHAR(32) NOT NULL,
    `unique_event_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `event_series_defs_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `visit_schedule_entries` (
    `id` VARCHAR(32) NOT NULL,
    `series_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `client_name` VARCHAR(160) NOT NULL,
    `client_phone` VARCHAR(20) NOT NULL,
    `weekdays` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `visit_schedule_entries_series_id_idx`(`series_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
