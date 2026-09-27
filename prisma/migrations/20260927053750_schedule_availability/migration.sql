-- AlterTable
ALTER TABLE `services` ADD COLUMN `online_window` JSON NULL;

-- CreateTable
CREATE TABLE `work_schedules` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `workplace` VARCHAR(8) NOT NULL,
    `week` JSON NOT NULL,
    `open_until` VARCHAR(10) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `work_schedules_business_id_idx`(`business_id`),
    INDEX `work_schedules_staff_id_idx`(`staff_id`),
    INDEX `work_schedules_location_id_idx`(`location_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_days` (
    `schedule_id` VARCHAR(32) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `hours` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `schedule_days_staff_id_date_idx`(`staff_id`, `date`),
    PRIMARY KEY (`schedule_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_day_types` (
    `staff_id` VARCHAR(32) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `type_id` VARCHAR(40) NOT NULL,
    `vacation_until` VARCHAR(10) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `staff_day_types_business_id_date_idx`(`business_id`, `date`),
    PRIMARY KEY (`staff_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `calendar_marks` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `from_time` VARCHAR(5) NOT NULL,
    `to_time` VARCHAR(5) NOT NULL,
    `kind` VARCHAR(4) NOT NULL,
    `workplace` VARCHAR(8) NULL,
    `note` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `calendar_marks_staff_id_date_idx`(`staff_id`, `date`),
    INDEX `calendar_marks_business_id_date_idx`(`business_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_templates` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `weekdays` JSON NULL,
    `shift_work` INTEGER NULL,
    `shift_off` INTEGER NULL,
    `hours` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `schedule_templates_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_history` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `action` VARCHAR(20) NOT NULL,
    `target_staff_ids` JSON NOT NULL,
    `dates` JSON NOT NULL,
    `summary` VARCHAR(500) NOT NULL DEFAULT '',
    `details` JSON NULL,
    `actor_name` VARCHAR(120) NOT NULL,
    `actor_staff_id` VARCHAR(32) NULL,

    INDEX `schedule_history_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_slot_rules` (
    `scope` VARCHAR(8) NOT NULL,
    `scope_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `rules` JSON NULL,
    `own_rules` BOOLEAN NOT NULL DEFAULT false,
    `unavailable` JSON NULL,
    `buffer_min` INTEGER NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `online_slot_rules_business_id_idx`(`business_id`),
    PRIMARY KEY (`scope`, `scope_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `person_locks` (
    `person_key` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`person_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `resource_locks` (
    `resource_id` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`resource_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `busy_blocks` (
    `id` VARCHAR(32) NOT NULL,
    `person_key` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `workplace` VARCHAR(8) NULL,
    `start_at` DATETIME(3) NOT NULL,
    `end_at` DATETIME(3) NOT NULL,
    `service_end_at` DATETIME(3) NOT NULL,
    `source` VARCHAR(12) NOT NULL,
    `source_id` VARCHAR(32) NOT NULL,
    `visibility_label` VARCHAR(6) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `no_show` BOOLEAN NOT NULL DEFAULT false,
    `hold_until` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `busy_blocks_person_key_active_start_at_end_at_idx`(`person_key`, `active`, `start_at`, `end_at`),
    INDEX `busy_blocks_source_source_id_idx`(`source`, `source_id`),
    INDEX `busy_blocks_business_id_start_at_idx`(`business_id`, `start_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `resource_busy` (
    `id` VARCHAR(32) NOT NULL,
    `resource_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `start_at` DATETIME(3) NOT NULL,
    `end_at` DATETIME(3) NOT NULL,
    `source` VARCHAR(12) NOT NULL,
    `source_id` VARCHAR(32) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `no_show` BOOLEAN NOT NULL DEFAULT false,
    `hold_until` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `resource_busy_resource_id_active_start_at_end_at_idx`(`resource_id`, `active`, `start_at`, `end_at`),
    INDEX `resource_busy_source_source_id_idx`(`source`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `work_schedules` ADD CONSTRAINT `work_schedules_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_days` ADD CONSTRAINT `schedule_days_schedule_id_fkey` FOREIGN KEY (`schedule_id`) REFERENCES `work_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `calendar_marks` ADD CONSTRAINT `calendar_marks_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
