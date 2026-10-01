-- CreateTable
CREATE TABLE `telegram_links` (
    `id` VARCHAR(32) NOT NULL,
    `chat_id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(16) NOT NULL,
    `app_user_id` VARCHAR(32) NULL,
    `language_code` VARCHAR(8) NULL,
    `blocked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `telegram_links_chat_id_key`(`chat_id`),
    INDEX `telegram_links_phone_idx`(`phone`),
    INDEX `telegram_links_app_user_id_idx`(`app_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
