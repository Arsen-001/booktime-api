-- AlterTable
ALTER TABLE `networks` ADD COLUMN `lost_client_days` INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN `sms_balance` BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `network_users` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `phone` VARCHAR(16) NOT NULL,
    `email` VARCHAR(160) NULL,
    `permissions` JSON NOT NULL,
    `plan_report_frequency` VARCHAR(8) NULL,
    `last_visit_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `network_users_user_id_idx`(`user_id`),
    UNIQUE INDEX `network_users_network_id_user_id_key`(`network_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_fields` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `data_type` VARCHAR(10) NOT NULL,
    `api_key` VARCHAR(60) NOT NULL,
    `list_options` JSON NOT NULL,
    `editable_by_user` BOOLEAN NOT NULL DEFAULT false,
    `show_in_admin` BOOLEAN NOT NULL DEFAULT true,
    `always_show_in_booking_window` BOOLEAN NOT NULL DEFAULT false,
    `required_on_create` BOOLEAN NOT NULL DEFAULT false,
    `required_on_arrived` BOOLEAN NOT NULL DEFAULT false,
    `always_show_in_client_card` BOOLEAN NOT NULL DEFAULT false,
    `show_in_widget` BOOLEAN NOT NULL DEFAULT false,
    `required_in_widget` BOOLEAN NOT NULL DEFAULT false,
    `business_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `network_fields_network_id_kind_idx`(`network_id`, `kind`),
    UNIQUE INDEX `network_fields_network_id_kind_api_key_key`(`network_id`, `kind`, `api_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_service_category_links` (
    `network_id` VARCHAR(32) NOT NULL,
    `key` VARCHAR(160) NOT NULL,
    `subdivision_id` VARCHAR(32) NULL,
    `online_name` VARCHAR(160) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`network_id`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_service_locks` (
    `network_id` VARCHAR(32) NOT NULL,
    `key` VARCHAR(160) NOT NULL,
    `price_locked` BOOLEAN NOT NULL DEFAULT false,
    `description_locked` BOOLEAN NOT NULL DEFAULT false,
    `online_name` VARCHAR(160) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`network_id`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_goods_category_links` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `parent_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `network_goods_category_links_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_plan_cells` (
    `network_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `value` BIGINT NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`network_id`, `business_id`, `kind`, `month`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_broadcasts` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `channel` VARCHAR(6) NOT NULL,
    `scope` VARCHAR(10) NOT NULL,
    `text` VARCHAR(600) NOT NULL,
    `recipients` INTEGER NOT NULL,
    `opted_out` INTEGER NOT NULL DEFAULT 0,
    `cost` BIGINT NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `network_broadcasts_network_id_created_at_idx`(`network_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `network_users` ADD CONSTRAINT `network_users_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_users` ADD CONSTRAINT `network_users_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_fields` ADD CONSTRAINT `network_fields_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_service_category_links` ADD CONSTRAINT `network_service_category_links_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_service_locks` ADD CONSTRAINT `network_service_locks_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_goods_category_links` ADD CONSTRAINT `network_goods_category_links_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_plan_cells` ADD CONSTRAINT `network_plan_cells_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_broadcasts` ADD CONSTRAINT `network_broadcasts_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
