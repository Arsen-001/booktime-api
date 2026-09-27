-- AlterTable
ALTER TABLE `resource_busy` ADD COLUMN `instance_id` VARCHAR(40) NULL;

-- CreateTable
CREATE TABLE `bookings` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `start_at` DATETIME(3) NOT NULL,
    `end_at` DATETIME(3) NOT NULL,
    `duration_min` INTEGER NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `services` JSON NOT NULL,
    `total` BIGINT NOT NULL DEFAULT 0,
    `resource_ids` JSON NOT NULL,
    `workplace` VARCHAR(8) NOT NULL DEFAULT 'salon',
    `source` VARCHAR(10) NOT NULL,
    `created_by_ref` VARCHAR(32) NOT NULL,
    `for_whom` VARCHAR(6) NOT NULL DEFAULT 'self',
    `visitor_name` VARCHAR(160) NULL,
    `comment` TEXT NULL,
    `prepayment` JSON NULL,
    `hold_until` DATETIME(3) NULL,
    `confirm_deadline` DATETIME(3) NULL,
    `cancelled_late` BOOLEAN NOT NULL DEFAULT false,
    `cancel_reason` VARCHAR(24) NULL,
    `cancelled_by` VARCHAR(8) NULL,
    `group_event_id` VARCHAR(32) NULL,
    `series_id` VARCHAR(32) NULL,
    `visit_id` VARCHAR(32) NULL,
    `staff_assignment` VARCHAR(8) NULL,
    `extras` JSON NOT NULL,
    `paid_amount` BIGINT NOT NULL DEFAULT 0,
    `break_override_min` INTEGER NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` VARCHAR(32) NULL,
    `deleted_by_name` VARCHAR(160) NULL,
    `deleted_by_client` BOOLEAN NOT NULL DEFAULT false,
    `deletion_restore` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `bookings_business_id_start_at_idx`(`business_id`, `start_at`),
    INDEX `bookings_staff_id_start_at_idx`(`staff_id`, `start_at`),
    INDEX `bookings_client_id_start_at_idx`(`client_id`, `start_at`),
    INDEX `bookings_app_user_id_start_at_idx`(`app_user_id`, `start_at`),
    INDEX `bookings_location_id_start_at_idx`(`location_id`, `start_at`),
    INDEX `bookings_status_hold_until_idx`(`status`, `hold_until`),
    INDEX `bookings_group_event_id_idx`(`group_event_id`),
    INDEX `bookings_series_id_idx`(`series_id`),
    INDEX `bookings_visit_id_idx`(`visit_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_events` (
    `id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `kind` VARCHAR(8) NOT NULL,
    `from_status` VARCHAR(24) NULL,
    `to_status` VARCHAR(24) NULL,
    `prev_start` VARCHAR(16) NULL,
    `prev_staff_id` VARCHAR(32) NULL,
    `freed` JSON NULL,
    `by_ref` VARCHAR(32) NOT NULL,
    `late` BOOLEAN NULL,
    `reason` VARCHAR(24) NULL,
    `delay_min` INTEGER NULL,
    `start_local` VARCHAR(16) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `booking_events_business_id_at_idx`(`business_id`, `at`),
    INDEX `booking_events_app_user_id_at_idx`(`app_user_id`, `at`),
    INDEX `booking_events_booking_id_at_idx`(`booking_id`, `at`),
    INDEX `booking_events_staff_id_at_idx`(`staff_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_history` (
    `id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_name` VARCHAR(160) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `summary` VARCHAR(1000) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `booking_history_booking_id_at_idx`(`booking_id`, `at`),
    INDEX `booking_history_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `group_events` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `service_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `start_at` DATETIME(3) NOT NULL,
    `duration_min` INTEGER NOT NULL,
    `capacity` INTEGER NOT NULL,
    `resource_ids` JSON NOT NULL,
    `online_url` VARCHAR(1000) NULL,
    `series_id` VARCHAR(32) NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'scheduled',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `group_events_business_id_start_at_idx`(`business_id`, `start_at`),
    INDEX `group_events_staff_id_start_at_idx`(`staff_id`, `start_at`),
    INDEX `group_events_series_id_idx`(`series_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_series` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `rule` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_until` VARCHAR(10) NULL,
    `created_by_name` VARCHAR(160) NOT NULL DEFAULT '',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `booking_series_business_id_idx`(`business_id`),
    INDEX `booking_series_active_kind_idx`(`active`, `kind`),
    INDEX `booking_series_staff_id_idx`(`staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `package_groups` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `order_mode` VARCHAR(16) NOT NULL,
    `booking_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `package_groups_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `waitlist_entries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `client_name` VARCHAR(160) NOT NULL,
    `client_phone` VARCHAR(20) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `service_ids` JSON NOT NULL,
    `staff_ids` JSON NOT NULL,
    `slots` JSON NOT NULL,
    `comment` VARCHAR(2000) NOT NULL DEFAULT '',
    `booking_id` VARCHAR(32) NULL,
    `notified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `waitlist_entries_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `waitlist_entries_app_user_id_idx`(`app_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `freed_slots` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `start_at` DATETIME(3) NOT NULL,
    `end_at` DATETIME(3) NOT NULL,
    `duration_min` INTEGER NOT NULL,
    `source_booking_id` VARCHAR(32) NOT NULL,
    `stage` VARCHAR(12) NOT NULL,
    `waitlist_ids` JSON NOT NULL,
    `subscribers_at` DATETIME(3) NULL,
    `hot_at` DATETIME(3) NULL,
    `discount_pct` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `freed_slots_stage_start_at_idx`(`stage`, `start_at`),
    INDEX `freed_slots_business_id_start_at_idx`(`business_id`, `start_at`),
    INDEX `freed_slots_staff_id_start_at_idx`(`staff_id`, `start_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `slot_claims` (
    `token` VARCHAR(40) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `service_id` VARCHAR(32) NULL,
    `start_local` VARCHAR(16) NOT NULL,
    `start_at` DATETIME(3) NOT NULL,
    `client_name` VARCHAR(160) NULL,
    `client_phone` VARCHAR(20) NULL,
    `status` VARCHAR(8) NOT NULL DEFAULT 'pending',
    `used_booking_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `slot_claims_staff_id_start_at_idx`(`staff_id`, `start_at`),
    PRIMARY KEY (`token`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `medical_visit_notes` (
    `booking_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `author_name` VARCHAR(160) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `medical_visit_notes_business_id_idx`(`business_id`),
    PRIMARY KEY (`booking_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `medical_cards` (
    `client_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `medical_cards_business_id_idx`(`business_id`),
    PRIMARY KEY (`client_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `treatment_plans` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `title` VARCHAR(300) NOT NULL,
    `items` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `treatment_plans_client_id_idx`(`client_id`),
    INDEX `treatment_plans_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
