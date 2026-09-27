-- AlterTable
ALTER TABLE `integration_connections` ADD COLUMN `last_event_at` DATETIME(3) NULL,
    ADD COLUMN `last_event_kind` VARCHAR(10) NULL,
    ADD COLUMN `last_test` JSON NULL,
    ADD COLUMN `recent_errors` JSON NULL;

-- AlterTable
ALTER TABLE `report_exports` ADD COLUMN `operation` VARCHAR(20) NULL;

-- AlterTable
ALTER TABLE `staff_reviews` ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `webhook_addresses` ADD COLUMN `signing_secret` VARCHAR(64) NULL,
    ADD COLUMN `verified_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `online_client_fields_configs` (
    `business_id` VARCHAR(32) NOT NULL,
    `comment_hidden` BOOLEAN NOT NULL DEFAULT false,
    `comment_required` BOOLEAN NOT NULL DEFAULT false,
    `comment_label` VARCHAR(60) NOT NULL DEFAULT 'Комментарий к записи',
    `email_hidden` BOOLEAN NOT NULL DEFAULT false,
    `email_required` BOOLEAN NOT NULL DEFAULT false,
    `last_name_enabled` BOOLEAN NOT NULL DEFAULT false,
    `last_name_required` BOOLEAN NOT NULL DEFAULT false,
    `patronymic_enabled` BOOLEAN NOT NULL DEFAULT false,
    `patronymic_required` BOOLEAN NOT NULL DEFAULT false,
    `custom_fields` JSON NOT NULL,
    `widget_text` JSON NOT NULL,
    `partner_brands` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
