-- AlterTable
ALTER TABLE `bookings` ADD COLUMN `notify_override` JSON NULL;

-- AlterTable
ALTER TABLE `integration_connections` ADD COLUMN `config` JSON NULL;

-- CreateTable
CREATE TABLE `notify_type_overrides` (
    `business_id` VARCHAR(32) NOT NULL,
    `code` INTEGER NOT NULL,
    `enabled` BOOLEAN NULL,
    `channels` JSON NULL,
    `templates` JSON NULL,
    `email_extra` JSON NULL,
    `conditions` JSON NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`business_id`, `code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
