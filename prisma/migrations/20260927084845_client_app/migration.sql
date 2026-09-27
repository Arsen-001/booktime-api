-- CreateTable
CREATE TABLE `favorites` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `target_type` VARCHAR(10) NOT NULL,
    `target_id` VARCHAR(32) NOT NULL,
    `news_muted` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `favorites_target_type_target_id_idx`(`target_type`, `target_id`),
    UNIQUE INDEX `favorites_app_user_id_target_type_target_id_key`(`app_user_id`, `target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `star_ratings` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `star_ratings_staff_id_idx`(`staff_id`),
    UNIQUE INDEX `star_ratings_app_user_id_staff_id_key`(`app_user_id`, `staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `diary_entries` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `service_name` VARCHAR(200) NOT NULL,
    `master_name` VARCHAR(160) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `amount` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `diary_entries_app_user_id_date_idx`(`app_user_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `callback_requests` (
    `id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `name` VARCHAR(160) NULL,
    `seen_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `callback_requests_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `callback_requests_staff_id_idx`(`staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `demand_leads` (
    `id` VARCHAR(32) NOT NULL,
    `query` VARCHAR(200) NOT NULL,
    `sphere_id` VARCHAR(20) NULL,
    `district` VARCHAR(20) NULL,
    `phone` VARCHAR(20) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `demand_leads_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `support_tickets` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NULL,
    `phone` VARCHAR(20) NULL,
    `subject` VARCHAR(200) NOT NULL,
    `message` TEXT NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'open',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `support_tickets_app_user_id_created_at_idx`(`app_user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox_items` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `staff_id` VARCHAR(32) NULL,
    `booking_id` VARCHAR(32) NULL,
    `params` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `read_at` DATETIME(3) NULL,

    INDEX `inbox_items_app_user_id_created_at_idx`(`app_user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
