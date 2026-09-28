-- CreateTable
CREATE TABLE `integration_catalog_apps` (
    `id` VARCHAR(40) NOT NULL,
    `code` VARCHAR(80) NOT NULL,
    `category_id` VARCHAR(30) NOT NULL,
    `builtin` BOOLEAN NOT NULL DEFAULT false,
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `featured_rank` INTEGER NULL,
    `installs_count` INTEGER NOT NULL DEFAULT 0,
    `rating` DOUBLE NOT NULL DEFAULT 0,
    `reviews_count` INTEGER NOT NULL DEFAULT 0,
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `integration_catalog_apps_code_key`(`code`),
    INDEX `integration_catalog_apps_category_id_idx`(`category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_app_reviews` (
    `id` VARCHAR(32) NOT NULL,
    `app_id` VARCHAR(40) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_name` VARCHAR(120) NOT NULL,
    `rating` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `integration_app_reviews_app_id_created_at_idx`(`app_id`, `created_at`),
    INDEX `integration_app_reviews_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_category_subscriptions` (
    `business_id` VARCHAR(32) NOT NULL,
    `category_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`business_id`, `category_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_promo_blocks` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `integration_promo_blocks_business_id_created_at_idx`(`business_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_developer_accounts` (
    `owner_staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `integration_developer_accounts_business_id_idx`(`business_id`),
    PRIMARY KEY (`owner_staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_dev_apps` (
    `id` VARCHAR(32) NOT NULL,
    `owner_staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `app_code` VARCHAR(80) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `integration_dev_apps_app_code_key`(`app_code`),
    INDEX `integration_dev_apps_owner_staff_id_created_at_idx`(`owner_staff_id`, `created_at`),
    INDEX `integration_dev_apps_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_partner_applications` (
    `id` VARCHAR(32) NOT NULL,
    `app_id` VARCHAR(40) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `integration_partner_applications_business_id_app_id_key`(`business_id`, `app_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

