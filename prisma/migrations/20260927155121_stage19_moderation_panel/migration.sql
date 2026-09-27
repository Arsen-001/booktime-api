/*
  Warnings:

  - Added the required column `updated_at` to the `biz_requests` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `support_tickets` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `biz_requests` ADD COLUMN `number` INTEGER NULL,
    ADD COLUMN `replied_at` DATETIME(3) NULL,
    ADD COLUMN `reply` TEXT NULL,
    ADD COLUMN `updated_at` DATETIME(3) NULL;
UPDATE `biz_requests` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
ALTER TABLE `biz_requests` MODIFY `updated_at` DATETIME(3) NOT NULL;

-- AlterTable
ALTER TABLE `sphere_requests` ADD COLUMN `decided_at` DATETIME(3) NULL,
    ADD COLUMN `kind` VARCHAR(10) NOT NULL DEFAULT 'noSphere',
    ADD COLUMN `needs` JSON NULL,
    ADD COLUMN `note` VARCHAR(500) NULL,
    ADD COLUMN `phone` VARCHAR(20) NULL,
    ADD COLUMN `sphere_name` VARCHAR(160) NULL,
    MODIFY `business_id` VARCHAR(32) NULL,
    MODIFY `author_staff_id` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `support_tickets` ADD COLUMN `channel` VARCHAR(10) NOT NULL DEFAULT 'app',
    ADD COLUMN `messages` JSON NULL,
    ADD COLUMN `name` VARCHAR(160) NULL,
    ADD COLUMN `number` INTEGER NULL,
    ADD COLUMN `section` VARCHAR(20) NULL,
    ADD COLUMN `topic` VARCHAR(12) NOT NULL DEFAULT 'other',
    ADD COLUMN `updated_at` DATETIME(3) NULL;
UPDATE `support_tickets` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
ALTER TABLE `support_tickets` MODIFY `updated_at` DATETIME(3) NOT NULL;

-- CreateTable
CREATE TABLE `reject_reasons` (
    `id` VARCHAR(32) NOT NULL,
    `label` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `moderation_items` (
    `id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NULL,
    `service_id` VARCHAR(32) NULL,
    `ref_id` VARCHAR(64) NOT NULL,
    `label` VARCHAR(200) NULL,
    `text` TEXT NULL,
    `image_url` LONGTEXT NULL,
    `tone` INTEGER NULL,
    `paid_coins` INTEGER NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'pending',
    `source` VARCHAR(10) NOT NULL DEFAULT 'user',
    `reason_id` VARCHAR(32) NULL,
    `reason_note` VARCHAR(300) NULL,
    `target_item_id` VARCHAR(32) NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `history` JSON NOT NULL,

    INDEX `moderation_items_business_id_submitted_at_idx`(`business_id`, `submitted_at`),
    INDEX `moderation_items_status_kind_submitted_at_idx`(`status`, `kind`, `submitted_at`),
    INDEX `moderation_items_ref_id_idx`(`ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `biz_meta` (
    `business_id` VARCHAR(32) NOT NULL,
    `source` VARCHAR(6) NOT NULL DEFAULT 'self',
    `responsible_id` VARCHAR(32) NULL,
    `promo_code_id` VARCHAR(32) NULL,
    `data_handed_at` DATETIME(3) NULL,
    `note` VARCHAR(500) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `backup_copies` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'manual',
    `counts` JSON NOT NULL,
    `size_kb` INTEGER NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `backup_copies_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ideas` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_name` VARCHAR(160) NOT NULL,
    `text` VARCHAR(2000) NOT NULL,
    `votes` INTEGER NOT NULL DEFAULT 0,
    `voter_ids` JSON NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'considering',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `notified_at` DATETIME(3) NULL,

    INDEX `ideas_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_visits` (
    `id` VARCHAR(32) NOT NULL,
    `place_name` VARCHAR(160) NOT NULL,
    `contact_name` VARCHAR(160) NULL,
    `phone` VARCHAR(20) NULL,
    `district` VARCHAR(20) NULL,
    `address` VARCHAR(300) NULL,
    `sphere_id` VARCHAR(40) NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'thinking',
    `visited_at` VARCHAR(10) NOT NULL,
    `callback_date` VARCHAR(10) NULL,
    `refusal_reason` VARCHAR(300) NULL,
    `note` VARCHAR(2000) NULL,
    `current_tool` VARCHAR(10) NULL,
    `willing_to_pay` BIGINT NULL,
    `responsible_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `promo_code_id` VARCHAR(32) NULL,
    `history` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `sales_visits_status_callback_date_idx`(`status`, `callback_date`),
    INDEX `sales_visits_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_counters` (
    `key` VARCHAR(20) NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `biz_requests_kind_status_updated_at_idx` ON `biz_requests`(`kind`, `status`, `updated_at`);

-- CreateIndex
CREATE INDEX `sphere_requests_kind_status_created_at_idx` ON `sphere_requests`(`kind`, `status`, `created_at`);

-- CreateIndex
CREATE INDEX `support_tickets_status_updated_at_idx` ON `support_tickets`(`status`, `updated_at`);
