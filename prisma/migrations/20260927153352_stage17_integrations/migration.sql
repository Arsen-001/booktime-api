-- CreateTable
CREATE TABLE `api_keys` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `label` VARCHAR(120) NULL,
    `scope` VARCHAR(10) NULL,
    `token_hash` VARCHAR(64) NOT NULL,
    `token_preview` VARCHAR(8) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,
    `revoked_at` DATETIME(3) NULL,

    INDEX `api_keys_business_id_kind_idx`(`business_id`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhooks` (
    `business_id` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `entities` JSON NOT NULL,
    `secret` VARCHAR(64) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_addresses` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `legacy` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_addresses_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `address_id` VARCHAR(32) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `entity` VARCHAR(20) NOT NULL,
    `action` VARCHAR(8) NOT NULL,
    `object_label` VARCHAR(200) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NULL,
    `last_error` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivered_at` DATETIME(3) NULL,

    INDEX `webhook_deliveries_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `webhook_deliveries_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_connections` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `app_id` VARCHAR(60) NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `granted_scopes` JSON NOT NULL,
    `connected_at` DATETIME(3) NOT NULL,
    `activates_by` DATETIME(3) NULL,
    `activated_at` DATETIME(3) NULL,
    `disconnected_at` DATETIME(3) NULL,
    `paid_until` DATETIME(3) NULL,
    `system_user_id` VARCHAR(32) NULL,
    `error_text` VARCHAR(200) NULL,

    INDEX `integration_connections_business_id_location_id_idx`(`business_id`, `location_id`),
    INDEX `integration_connections_app_id_idx`(`app_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
