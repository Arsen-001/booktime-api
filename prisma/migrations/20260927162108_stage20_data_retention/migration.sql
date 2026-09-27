-- AlterTable
ALTER TABLE `users` ADD COLUMN `data_block_requested_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `account_data_exports` (
    `id` VARCHAR(32) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `account_data_exports_user_id_at_idx`(`user_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
