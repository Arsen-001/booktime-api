-- CreateTable
CREATE TABLE `notify_log_entries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `dedupe_key` VARCHAR(120) NOT NULL,
    `sent_at` DATETIME(3) NOT NULL,
    `type_code` INTEGER NULL,
    `type_label` JSON NOT NULL,
    `channel` VARCHAR(12) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `contact` VARCHAR(160) NOT NULL,
    `text` JSON NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `staff_id` VARCHAR(32) NULL,
    `booking_id` VARCHAR(32) NULL,
    `sent_language` VARCHAR(2) NULL,
    `cost_amd` INTEGER NOT NULL DEFAULT 0,
    `sms_parts` INTEGER NULL,
    `deferred_from` DATETIME(3) NULL,
    `source` VARCHAR(8) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notify_log_entries_dedupe_key_key`(`dedupe_key`),
    INDEX `notify_log_entries_business_id_sent_at_idx`(`business_id`, `sent_at`),
    INDEX `notify_log_entries_business_id_channel_sent_at_idx`(`business_id`, `channel`, `sent_at`),
    INDEX `notify_log_entries_business_id_status_sent_at_idx`(`business_id`, `status`, `sent_at`),
    INDEX `notify_log_entries_business_id_type_code_sent_at_idx`(`business_id`, `type_code`, `sent_at`),
    INDEX `notify_log_entries_client_id_sent_at_idx`(`client_id`, `sent_at`),
    INDEX `notify_log_entries_booking_id_idx`(`booking_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notify_log_sync` (
    `business_id` VARCHAR(32) NOT NULL,
    `synced_until` DATETIME(3) NOT NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notify_mailings` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `text` TEXT NOT NULL,
    `audience_label` VARCHAR(400) NOT NULL,
    `recipients_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(10) NOT NULL,
    `network` BOOLEAN NOT NULL DEFAULT false,
    `business_ids` JSON NOT NULL,
    `filter` JSON NOT NULL,
    `scheduled_at` DATETIME(3) NULL,
    `sent_at` DATETIME(3) NULL,
    `cost_amd` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `notify_mailings_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `notify_mailings_status_scheduled_at_idx`(`status`, `scheduled_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notify_mailing_recipients` (
    `mailing_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notify_mailing_recipients_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `notify_mailing_recipients_client_id_idx`(`client_id`),
    PRIMARY KEY (`mailing_id`, `client_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
