-- DropForeignKey
ALTER TABLE `network_users` DROP FOREIGN KEY `network_users_user_id_fkey`;

-- AlterTable
ALTER TABLE `app_profiles` ADD COLUMN `network_default_locations` JSON NULL,
    ADD COLUMN `news_push_opt_out` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `bookings` ADD COLUMN `reminder_override` JSON NULL;

-- AlterTable
ALTER TABLE `network_users` ADD COLUMN `pending` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `staff_login_id` VARCHAR(32) NULL,
    MODIFY `user_id` VARCHAR(32) NULL,
    MODIFY `phone` VARCHAR(16) NULL;

-- CreateTable
CREATE TABLE `network_subdivisions` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `category_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `network_subdivisions_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_off_day_types` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `comment` VARCHAR(400) NULL,
    `color_index` INTEGER NOT NULL DEFAULT 1,
    `business_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `network_off_day_types_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_staff_order` (
    `network_id` VARCHAR(32) NOT NULL,
    `ordered_keys` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`network_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_reminders` (
    `booking_id` VARCHAR(32) NOT NULL,
    `remind_at` DATETIME(3) NULL,
    `revisit_invite_days` INTEGER NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`booking_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_broadcast_messages` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `channel` VARCHAR(10) NOT NULL,
    `text` VARCHAR(1000) NOT NULL,
    `audience_count` INTEGER NOT NULL DEFAULT 1,
    `client_id` VARCHAR(32) NULL,
    `source` VARCHAR(16) NOT NULL DEFAULT 'bulk',
    `sent_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `client_broadcast_messages_business_id_sent_at_idx`(`business_id`, `sent_at`),
    INDEX `client_broadcast_messages_client_id_sent_at_idx`(`client_id`, `sent_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `translation_overrides` (
    `id` VARCHAR(32) NOT NULL,
    `owner` VARCHAR(10) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `field` VARCHAR(40) NOT NULL,
    `text` VARCHAR(4000) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    UNIQUE INDEX `translation_overrides_owner_owner_id_field_key`(`owner`, `owner_id`, `field`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_app_access` (
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    INDEX `employee_app_access_business_id_idx`(`business_id`),
    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_payroll_payouts` (
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `paid` BIGINT NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `network_users_staff_login_id_idx` ON `network_users`(`staff_login_id`);

-- AddForeignKey
ALTER TABLE `network_users` ADD CONSTRAINT `network_users_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_subdivisions` ADD CONSTRAINT `network_subdivisions_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_off_day_types` ADD CONSTRAINT `network_off_day_types_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_staff_order` ADD CONSTRAINT `network_staff_order_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
