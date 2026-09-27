-- CreateTable
CREATE TABLE `clients` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `last_name` VARCHAR(80) NULL,
    `middle_name` VARCHAR(80) NULL,
    `gender` VARCHAR(8) NOT NULL DEFAULT 'unknown',
    `birthday` VARCHAR(10) NULL,
    `email` VARCHAR(160) NULL,
    `note` VARCHAR(2000) NULL,
    `tags` JSON NOT NULL,
    `additional_phone` VARCHAR(20) NULL,
    `avatar_url` MEDIUMTEXT NULL,
    `discount_percent` INTEGER NOT NULL DEFAULT 0,
    `importance_class` VARCHAR(8) NULL,
    `card_number` VARCHAR(40) NULL,
    `paid_amount` BIGINT NOT NULL DEFAULT 0,
    `imported_sold` BIGINT NOT NULL DEFAULT 0,
    `national_id` VARCHAR(12) NULL,
    `ad_consent` JSON NULL,
    `birthday_greeting_opt_out` BOOLEAN NULL,
    `locale` VARCHAR(2) NULL,
    `preferred_contact` VARCHAR(6) NULL,
    `blocked` BOOLEAN NULL,
    `app_user_id` VARCHAR(32) NULL,
    `no_show_count` INTEGER NOT NULL DEFAULT 0,
    `custom_field_values` JSON NULL,
    `invited_at` DATETIME(3) NULL,
    `purged_at` DATETIME(3) NULL,
    `source` VARCHAR(20) NULL,
    `deleted_at` DATETIME(3) NULL,
    `deleted_by` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `clients_business_id_phone_idx`(`business_id`, `phone`),
    INDEX `clients_business_id_deleted_at_idx`(`business_id`, `deleted_at`),
    INDEX `clients_app_user_id_idx`(`app_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_categories` (
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `color` VARCHAR(20) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`business_id`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_comments` (
    `id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `author_id` VARCHAR(32) NULL,
    `author_name` VARCHAR(120) NOT NULL,
    `text` VARCHAR(2000) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deleted_at` DATETIME(3) NULL,

    INDEX `client_comments_client_id_created_at_idx`(`client_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_files` (
    `id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `ext` VARCHAR(10) NOT NULL,
    `size` INTEGER NOT NULL,
    `data_url` LONGTEXT NOT NULL,
    `uploaded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uploaded_by` VARCHAR(120) NOT NULL,

    INDEX `client_files_client_id_idx`(`client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_fine_rights` (
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `rights` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `client_fine_rights_business_id_idx`(`business_id`),
    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_columns_prefs` (
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL DEFAULT '',
    `visible` JSON NOT NULL,
    `pinned` JSON NOT NULL,

    PRIMARY KEY (`business_id`, `staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_import_runs` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_name` VARCHAR(120) NOT NULL,
    `method` VARCHAR(6) NOT NULL,
    `total_rows` INTEGER NOT NULL,
    `created_count` INTEGER NOT NULL,
    `updated_count` INTEGER NOT NULL,
    `rejected_count` INTEGER NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `client_import_runs_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `data_exports` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `area` VARCHAR(20) NOT NULL,
    `author_id` VARCHAR(32) NULL,
    `author_name` VARCHAR(120) NOT NULL,
    `count` INTEGER NOT NULL,
    `file_name` VARCHAR(200) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `data_exports_business_id_area_at_idx`(`business_id`, `area`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `clients` ADD CONSTRAINT `clients_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_categories` ADD CONSTRAINT `client_categories_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_comments` ADD CONSTRAINT `client_comments_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_files` ADD CONSTRAINT `client_files_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
