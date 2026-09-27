-- CreateTable
CREATE TABLE `notify_outbox` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `app` VARCHAR(10) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `recipient_user_id` VARCHAR(32) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` VARCHAR(600) NOT NULL,
    `url` VARCHAR(300) NULL,
    `dedupe_key` VARCHAR(160) NOT NULL,
    `send_at` DATETIME(3) NOT NULL,
    `status` VARCHAR(8) NOT NULL DEFAULT 'queued',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(300) NULL,
    `meta` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sent_at` DATETIME(3) NULL,

    UNIQUE INDEX `notify_outbox_dedupe_key_key`(`dedupe_key`),
    INDEX `notify_outbox_status_send_at_idx`(`status`, `send_at`),
    INDEX `notify_outbox_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `notify_outbox_recipient_user_id_created_at_idx`(`recipient_user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `news_posts` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `week_key` VARCHAR(8) NOT NULL,
    `text` JSON NOT NULL,
    `recipients_count` INTEGER NOT NULL DEFAULT 0,
    `created_by` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `news_posts_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `news_posts_business_id_week_key_idx`(`business_id`, `week_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `news_quota` (
    `business_id` VARCHAR(32) NOT NULL,
    `week_key` VARCHAR(8) NOT NULL,
    `sent` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`business_id`, `week_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_notify_prefs` (
    `staff_id` VARCHAR(32) NOT NULL,
    `events` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_notify_prefs` (
    `client_id` VARCHAR(32) NOT NULL,
    `marketing_opt_out` BOOLEAN NOT NULL DEFAULT false,
    `channels` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`client_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `biz_inbox_read` (
    `business_id` VARCHAR(32) NOT NULL,
    `event_id` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`business_id`, `event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
