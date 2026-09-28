-- CreateTable
CREATE TABLE `network_settings` (
    `network_id` VARCHAR(32) NOT NULL,
    `area` VARCHAR(40) NOT NULL,
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`network_id`, `area`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
