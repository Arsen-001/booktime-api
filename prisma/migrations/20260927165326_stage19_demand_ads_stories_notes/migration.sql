-- AlterTable
ALTER TABLE `demand_leads` ADD COLUMN `notify` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `first_awards` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `scope` VARCHAR(8) NOT NULL,
    `sphere_id` VARCHAR(20) NOT NULL,
    `district` VARCHAR(20) NULL,
    `free_days` INTEGER NOT NULL,
    `coins` INTEGER NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `first_awards_scope_sphere_id_district_idx`(`scope`, `sphere_id`, `district`),
    INDEX `first_awards_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ads` (
    `id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `text` VARCHAR(2000) NULL,
    `image_url` MEDIUMTEXT NULL,
    `cta_url` VARCHAR(1000) NULL,
    `advertiser_name` VARCHAR(160) NOT NULL,
    `advertiser_contact` VARCHAR(160) NOT NULL,
    `placement_id` VARCHAR(20) NOT NULL,
    `target_sphere_ids` JSON NOT NULL,
    `target_districts` JSON NOT NULL,
    `target_size` VARCHAR(12) NOT NULL DEFAULT 'any',
    `target_min_stars` INTEGER NULL,
    `product_keywords` JSON NOT NULL,
    `start_date` VARCHAR(10) NOT NULL,
    `end_date` VARCHAR(10) NOT NULL,
    `price` BIGINT NOT NULL,
    `paused` BOOLEAN NOT NULL DEFAULT false,
    `support_ticket_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ads_placement_id_paused_start_date_end_date_idx`(`placement_id`, `paused`, `start_date`, `end_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ad_day_stats` (
    `ad_id` VARCHAR(32) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `views` INTEGER NOT NULL DEFAULT 0,
    `clicks` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`ad_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `story_config` (
    `id` VARCHAR(10) NOT NULL DEFAULT 'singleton',
    `places` INTEGER NOT NULL DEFAULT 6,
    `scope` VARCHAR(8) NOT NULL DEFAULT 'city',
    `price_per_day` INTEGER NOT NULL DEFAULT 2000,
    `last_places_count` INTEGER NOT NULL DEFAULT 2,
    `last_places_markup` INTEGER NOT NULL DEFAULT 50,
    `queue_markup` INTEGER NOT NULL DEFAULT 30,
    `days_ahead` INTEGER NOT NULL DEFAULT 14,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `story_bookings` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `district` VARCHAR(40) NULL,
    `mode` VARCHAR(6) NOT NULL,
    `price` INTEGER NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'active',
    `source` VARCHAR(10) NOT NULL DEFAULT 'photo',
    `moderation_item_id` VARCHAR(32) NULL,
    `views` INTEGER NOT NULL DEFAULT 0,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `bookings_from_story` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `story_bookings_date_status_idx`(`date`, `status`),
    INDEX `story_bookings_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `story_day_locks` (
    `day_key` VARCHAR(50) NOT NULL,

    PRIMARY KEY (`day_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_notes` (
    `id` VARCHAR(10) NOT NULL DEFAULT 'singleton',
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
