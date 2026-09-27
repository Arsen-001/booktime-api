-- CreateTable
CREATE TABLE `report_favorites` (
    `staff_id` VARCHAR(32) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`staff_id`, `slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_reports_permissions` (
    `staff_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_exports` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `staff_name` VARCHAR(120) NOT NULL,
    `name` VARCHAR(24) NOT NULL,
    `params` JSON NOT NULL,
    `status` VARCHAR(8) NOT NULL DEFAULT 'queued',
    `file_name` VARCHAR(200) NULL,
    `storage_key` VARCHAR(300) NULL,
    `row_count` INTEGER NULL,
    `error` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ready_at` DATETIME(3) NULL,

    INDEX `report_exports_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `report_exports_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
