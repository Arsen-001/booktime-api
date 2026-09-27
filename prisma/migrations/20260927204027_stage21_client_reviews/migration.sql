-- CreateTable
CREATE TABLE `staff_reviews` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `rating` INTEGER NOT NULL,
    `text` VARCHAR(2000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `staff_reviews_staff_id_idx`(`staff_id`),
    INDEX `staff_reviews_business_id_idx`(`business_id`),
    UNIQUE INDEX `staff_reviews_app_user_id_staff_id_key`(`app_user_id`, `staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `location_reviews` (
    `id` VARCHAR(32) NOT NULL,
    `app_user_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `text` VARCHAR(2000) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `location_reviews_business_id_idx`(`business_id`),
    UNIQUE INDEX `location_reviews_app_user_id_booking_id_key`(`app_user_id`, `booking_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
