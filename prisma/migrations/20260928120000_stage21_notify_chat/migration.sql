-- CreateTable
CREATE TABLE `notify_chat_messages` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `direction` VARCHAR(3) NOT NULL,
    `text` TEXT NOT NULL,
    `attachment_name` VARCHAR(200) NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notify_chat_messages_business_id_phone_created_at_idx`(`business_id`, `phone`, `created_at`),
    INDEX `notify_chat_messages_business_id_direction_read_at_idx`(`business_id`, `direction`, `read_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

