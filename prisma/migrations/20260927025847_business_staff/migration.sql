-- CreateTable
CREATE TABLE `networks` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `owner_user_id` VARCHAR(32) NOT NULL,
    `owner_staff_id` VARCHAR(32) NULL,
    `main_business_id` VARCHAR(32) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `networks_owner_user_id_idx`(`owner_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `businesses` (
    `id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(120) NOT NULL,
    `sphere_ids` JSON NOT NULL,
    `network_id` VARCHAR(32) NULL,
    `owner_staff_id` VARCHAR(32) NULL,
    `phone` VARCHAR(16) NOT NULL,
    `description` JSON NULL,
    `logo_url` MEDIUMTEXT NULL,
    `photos` JSON NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
    `left_at` DATETIME(3) NULL,
    `forbid_home_bookings_during_shift` BOOLEAN NOT NULL DEFAULT false,
    `socials` JSON NULL,
    `booking_rules` JSON NULL,
    `brand_name` VARCHAR(160) NULL,
    `ads_opt_in` BOOLEAN NOT NULL DEFAULT false,
    `signup_promo_code` VARCHAR(40) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `businesses_slug_key`(`slug`),
    INDEX `businesses_status_idx`(`status`),
    INDEX `businesses_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `locations` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` JSON NOT NULL,
    `address` JSON NOT NULL,
    `district` VARCHAR(40) NOT NULL,
    `yandex_maps_url` VARCHAR(1000) NULL,
    `lat` DECIMAL(9, 6) NULL,
    `lng` DECIMAL(9, 6) NULL,
    `coords_at` DATETIME(3) NULL,
    `phone` VARCHAR(16) NULL,
    `extra_phones` JSON NULL,
    `hours_text` VARCHAR(200) NULL,
    `open_hours` JSON NULL,
    `journal_kind` VARCHAR(12) NULL,
    `tz` VARCHAR(40) NOT NULL DEFAULT 'Asia/Yerevan',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `locations_business_id_idx`(`business_id`),
    INDEX `locations_district_idx`(`district`),
    INDEX `locations_lat_lng_idx`(`lat`, `lng`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_settings` (
    `business_id` VARCHAR(32) NOT NULL,
    `area` VARCHAR(40) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`business_id`, `area`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `user_id` VARCHAR(32) NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(16) NOT NULL DEFAULT '',
    `email` VARCHAR(160) NULL,
    `role` VARCHAR(8) NOT NULL,
    `role_template_id` VARCHAR(16) NULL,
    `status` VARCHAR(10) NOT NULL,
    `position` JSON NULL,
    `position_id` VARCHAR(32) NULL,
    `specialty` JSON NULL,
    `sphere_ids` JSON NOT NULL,
    `avatar_url` MEDIUMTEXT NULL,
    `bio` JSON NULL,
    `photos` JSON NOT NULL,
    `materials` JSON NOT NULL,
    `workplaces` JSON NOT NULL,
    `home_address` VARCHAR(300) NULL,
    `home_district` VARCHAR(40) NULL,
    `visit_districts` JSON NULL,
    `accepts` VARCHAR(6) NOT NULL DEFAULT 'all',
    `calendar_visibility` VARCHAR(5) NOT NULL DEFAULT 'all',
    `calendar_mode` VARCHAR(5) NOT NULL DEFAULT 'free',
    `confirm_mode` VARCHAR(8) NOT NULL DEFAULT 'manual',
    `color_index` INTEGER NOT NULL DEFAULT 1,
    `service_ids` JSON NOT NULL,
    `call_hours` JSON NULL,
    `hired_at` VARCHAR(10) NOT NULL,
    `online_booking_enabled` BOOLEAN NOT NULL DEFAULT true,
    `hidden_in_journal` BOOLEAN NOT NULL DEFAULT false,
    `assistant_only` BOOLEAN NOT NULL DEFAULT false,
    `journal_markup_min` INTEGER NULL,
    `prepayment` JSON NULL,
    `booking_rules` JSON NULL,
    `contacts` JSON NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `access_enabled` BOOLEAN NOT NULL DEFAULT true,
    `access_info` VARCHAR(500) NULL,
    `ip_restriction` JSON NULL,
    `permissions` JSON NULL,
    `rights` JSON NULL,
    `right_scopes` JSON NULL,
    `legal_info` JSON NULL,
    `card_settings` JSON NULL,
    `push_prefs` JSON NULL,
    `fired_on` VARCHAR(10) NULL,
    `fire_reason` VARCHAR(500) NULL,
    `fired_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `staff_business_id_status_idx`(`business_id`, `status`),
    INDEX `staff_user_id_idx`(`user_id`),
    INDEX `staff_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_locations` (
    `staff_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,

    INDEX `staff_locations_location_id_idx`(`location_id`),
    PRIMARY KEY (`staff_id`, `location_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `positions` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `network_id` VARCHAR(32) NULL,
    `name` JSON NOT NULL,
    `name_norm` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `positions_business_id_name_norm_idx`(`business_id`, `name_norm`),
    INDEX `positions_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_invites` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `role` VARCHAR(8) NOT NULL,
    `phone` VARCHAR(16) NULL,
    `email` VARCHAR(160) NULL,
    `token_hash` CHAR(64) NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'pending',
    `expires_at` DATETIME(3) NOT NULL,
    `sent_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `answered_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `staff_invites_token_hash_key`(`token_hash`),
    INDEX `staff_invites_business_id_idx`(`business_id`),
    INDEX `staff_invites_staff_id_idx`(`staff_id`),
    INDEX `staff_invites_phone_status_idx`(`phone`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `master_profiles` (
    `user_id` VARCHAR(32) NOT NULL,
    `photos` JSON NOT NULL,
    `diplomas` JSON NOT NULL,
    `materials` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- Логины администраторов, созданные до этапа 3, ссылались на сотрудников, которых ещё не было в базе: связь
-- снимаем, сид (или владелец) проставит её заново
UPDATE `staff_logins` SET `staff_id` = NULL WHERE `staff_id` IS NOT NULL AND `staff_id` NOT IN (SELECT `id` FROM `staff`);

ALTER TABLE `staff_logins` ADD CONSTRAINT `staff_logins_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `networks` ADD CONSTRAINT `networks_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `businesses` ADD CONSTRAINT `businesses_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `locations` ADD CONSTRAINT `locations_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_settings` ADD CONSTRAINT `business_settings_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff` ADD CONSTRAINT `staff_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff` ADD CONSTRAINT `staff_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff_locations` ADD CONSTRAINT `staff_locations_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff_locations` ADD CONSTRAINT `staff_locations_location_id_fkey` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `positions` ADD CONSTRAINT `positions_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `positions` ADD CONSTRAINT `positions_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff_invites` ADD CONSTRAINT `staff_invites_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff_invites` ADD CONSTRAINT `staff_invites_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `master_profiles` ADD CONSTRAINT `master_profiles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
