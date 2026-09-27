-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(16) NULL,
    `name` VARCHAR(120) NOT NULL,
    `locale` VARCHAR(2) NOT NULL DEFAULT 'ru',
    `two_factor_enabled` BOOLEAN NOT NULL DEFAULT false,
    `sessions_revoked_at` DATETIME(3) NULL,
    `blocked_at` DATETIME(3) NULL,
    `delete_requested_at` DATETIME(3) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `users_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_profiles` (
    `user_id` VARCHAR(32) NOT NULL,
    `gender` VARCHAR(8) NOT NULL DEFAULT 'unknown',
    `birthday` VARCHAR(10) NULL,
    `district` VARCHAR(40) NULL,
    `photo_url` VARCHAR(500) NULL,
    `big_font` BOOLEAN NOT NULL DEFAULT false,
    `time_format` VARCHAR(3) NOT NULL DEFAULT '24h',
    `consent_at` DATETIME(3) NULL,
    `consent_version` VARCHAR(20) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(32) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `app` VARCHAR(10) NOT NULL,
    `mode` VARCHAR(10) NOT NULL DEFAULT 'client',
    `active_business_id` VARCHAR(32) NULL,
    `staff_login_id` VARCHAR(32) NULL,
    `platform_member_id` VARCHAR(32) NULL,
    `must_change_password` BOOLEAN NOT NULL DEFAULT false,
    `device` VARCHAR(200) NOT NULL,
    `ip` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `revoke_reason` VARCHAR(20) NULL,

    UNIQUE INDEX `sessions_token_hash_key`(`token_hash`),
    INDEX `sessions_user_id_revoked_at_idx`(`user_id`, `revoked_at`),
    INDEX `sessions_staff_login_id_idx`(`staff_login_id`),
    INDEX `sessions_platform_member_id_idx`(`platform_member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `otp_requests` (
    `id` VARCHAR(32) NOT NULL,
    `phone` VARCHAR(16) NOT NULL,
    `purpose` VARCHAR(16) NOT NULL,
    `channel` VARCHAR(10) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `subject_id` VARCHAR(32) NULL,
    `user_id` VARCHAR(32) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(12) NOT NULL DEFAULT 'sent',
    `provider_message_id` VARCHAR(100) NULL,
    `ip` VARCHAR(64) NOT NULL,
    `sent_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,

    INDEX `otp_requests_phone_purpose_sent_at_idx`(`phone`, `purpose`, `sent_at`),
    INDEX `otp_requests_ip_sent_at_idx`(`ip`, `sent_at`),
    INDEX `otp_requests_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_logins` (
    `id` VARCHAR(32) NOT NULL,
    `login` VARCHAR(64) NOT NULL,
    `password_hash` VARCHAR(200) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NULL,
    `business_id` VARCHAR(32) NULL,
    `must_change_password` BOOLEAN NOT NULL DEFAULT true,
    `failed_attempts` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `disabled_at` DATETIME(3) NULL,
    `password_changed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `staff_logins_login_key`(`login`),
    INDEX `staff_logins_user_id_idx`(`user_id`),
    INDEX `staff_logins_staff_id_idx`(`staff_id`),
    INDEX `staff_logins_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_members` (
    `id` VARCHAR(32) NOT NULL,
    `login` VARCHAR(64) NOT NULL,
    `password_hash` VARCHAR(200) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'reviewer',
    `failed_attempts` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `disabled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `platform_members_login_key`(`login`),
    UNIQUE INDEX `platform_members_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_events` (
    `id` VARCHAR(32) NOT NULL,
    `user_id` VARCHAR(32) NULL,
    `session_id` VARCHAR(32) NULL,
    `method` VARCHAR(16) NOT NULL,
    `app` VARCHAR(10) NOT NULL,
    `result` VARCHAR(20) NOT NULL,
    `identifier` VARCHAR(64) NULL,
    `ip` VARCHAR(64) NOT NULL,
    `device` VARCHAR(200) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_events_user_id_at_idx`(`user_id`, `at`),
    INDEX `login_events_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `push_tokens` (
    `id` VARCHAR(32) NOT NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `app` VARCHAR(10) NOT NULL,
    `platform` VARCHAR(8) NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `subscription` JSON NULL,
    `locale` VARCHAR(2) NOT NULL DEFAULT 'ru',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `invalid_at` DATETIME(3) NULL,

    UNIQUE INDEX `push_tokens_token_key`(`token`),
    INDEX `push_tokens_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `app_profiles` ADD CONSTRAINT `app_profiles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_staff_login_id_fkey` FOREIGN KEY (`staff_login_id`) REFERENCES `staff_logins`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_platform_member_id_fkey` FOREIGN KEY (`platform_member_id`) REFERENCES `platform_members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staff_logins` ADD CONSTRAINT `staff_logins_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_members` ADD CONSTRAINT `platform_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `login_events` ADD CONSTRAINT `login_events_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `push_tokens` ADD CONSTRAINT `push_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
