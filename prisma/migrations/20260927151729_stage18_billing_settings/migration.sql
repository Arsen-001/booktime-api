-- CreateTable
CREATE TABLE `platform_prices` (
    `key` VARCHAR(40) NOT NULL,
    `value` BIGINT NOT NULL,
    `note` VARCHAR(200) NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `price_rule_changes` (
    `id` VARCHAR(32) NOT NULL,
    `effective_from` VARCHAR(10) NOT NULL,
    `announced_at` VARCHAR(10) NOT NULL,
    `description_key` VARCHAR(40) NOT NULL,
    `old_price` BIGINT NOT NULL,
    `new_price` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `business_id` VARCHAR(32) NOT NULL,
    `status` VARCHAR(12) NOT NULL,
    `paid_until` DATETIME(3) NOT NULL,
    `free_until` DATETIME(3) NULL,
    `auto_renew` BOOLEAN NOT NULL DEFAULT true,
    `saved_card_id` VARCHAR(32) NULL,
    `promo_redemption_id` VARCHAR(32) NULL,
    `promo_code` VARCHAR(40) NULL,
    `promo_tiers` JSON NULL,
    `promo_used_at` DATETIME(3) NULL,
    `payment_docs_email` BOOLEAN NOT NULL DEFAULT true,
    `grace_until` DATETIME(3) NULL,
    `warned_days` INTEGER NULL,
    `retry_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `subscriptions_status_paid_until_idx`(`status`, `paid_until`),
    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_charges` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `period_start` DATETIME(3) NOT NULL,
    `period_end` DATETIME(3) NOT NULL,
    `months` INTEGER NOT NULL,
    `seats_masters` INTEGER NOT NULL,
    `seats_admins` INTEGER NOT NULL,
    `base_amount` BIGINT NOT NULL,
    `discount_pct` INTEGER NOT NULL DEFAULT 0,
    `amount` BIGINT NOT NULL,
    `method` VARCHAR(12) NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `provider` VARCHAR(12) NOT NULL,
    `provider_ref` VARCHAR(80) NULL,
    `invoice_id` VARCHAR(32) NULL,
    `trigger` VARCHAR(8) NOT NULL DEFAULT 'manual',
    `attempted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `paid_at` DATETIME(3) NULL,
    `created_by` VARCHAR(32) NULL,

    INDEX `subscription_charges_business_id_attempted_at_idx`(`business_id`, `attempted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_invoices` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `number` VARCHAR(20) NOT NULL,
    `purpose` VARCHAR(12) NOT NULL,
    `amount` BIGINT NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `period_from` VARCHAR(10) NULL,
    `period_to` VARCHAR(10) NULL,
    `method` VARCHAR(12) NULL,
    `payer` JSON NULL,
    `ref_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `paid_at` DATETIME(3) NULL,

    UNIQUE INDEX `billing_invoices_number_key`(`number`),
    INDEX `billing_invoices_business_id_created_at_idx`(`business_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_counters` (
    `key` VARCHAR(20) NOT NULL,
    `value` INTEGER NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_cards` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(12) NOT NULL,
    `method` VARCHAR(12) NOT NULL,
    `token` VARCHAR(200) NOT NULL,
    `label` VARCHAR(40) NOT NULL,
    `unavailable` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `saved_cards_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `free_period_grants` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `days` INTEGER NOT NULL,
    `reason` VARCHAR(8) NOT NULL,
    `by` VARCHAR(32) NOT NULL,
    `note` VARCHAR(300) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `free_period_grants_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promo_codes` (
    `id` VARCHAR(32) NOT NULL,
    `code` VARCHAR(24) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `tiers` JSON NOT NULL,
    `free_days` INTEGER NULL,
    `personal` BOOLEAN NOT NULL DEFAULT true,
    `issued_to` JSON NULL,
    `issued_at` DATETIME(3) NULL,
    `valid_until` VARCHAR(10) NULL,
    `revoked_at` DATETIME(3) NULL,
    `note` VARCHAR(300) NULL,
    `created_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promo_codes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promo_redemptions` (
    `id` VARCHAR(32) NOT NULL,
    `promo_code_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promo_redemptions_promo_code_id_key`(`promo_code_id`),
    INDEX `promo_redemptions_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coin_wallets` (
    `business_id` VARCHAR(32) NOT NULL,
    `balance` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coin_entries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `amount` INTEGER NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `reason` VARCHAR(40) NOT NULL,
    `area` VARCHAR(20) NOT NULL,
    `ref_id` VARCHAR(32) NULL,
    `price` BIGINT NULL,
    `idempotency_key` VARCHAR(80) NULL,
    `by` VARCHAR(32) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `coin_entries_idempotency_key_key`(`idempotency_key`),
    INDEX `coin_entries_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coin_packages` (
    `id` VARCHAR(20) NOT NULL,
    `coins` INTEGER NOT NULL,
    `price` BIGINT NOT NULL,
    `bonus_percent` INTEGER NOT NULL DEFAULT 0,
    `popular` BOOLEAN NOT NULL DEFAULT false,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings_change_log` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `section` VARCHAR(12) NOT NULL,
    `field_key` VARCHAR(40) NOT NULL,
    `before` TEXT NOT NULL,
    `after` TEXT NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `staff_name` VARCHAR(160) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `settings_change_log_business_id_at_idx`(`business_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `biz_requests` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_staff_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `topic` VARCHAR(12) NULL,
    `message` TEXT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'open',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `biz_requests_business_id_kind_created_at_idx`(`business_id`, `kind`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sphere_requests` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `author_staff_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `message` TEXT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'open',
    `checklist` JSON NULL,
    `eta_date` VARCHAR(10) NULL,
    `ready_at` VARCHAR(10) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sphere_requests_business_id_created_at_idx`(`business_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_account_prefs` (
    `staff_id` VARCHAR(32) NOT NULL,
    `notification_prefs` JSON NOT NULL,
    `start_page` VARCHAR(20) NULL,
    `start_location_id` VARCHAR(32) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
