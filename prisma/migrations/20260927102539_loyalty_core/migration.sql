-- CreateTable
CREATE TABLE `loyalty_card_types` (
    `id` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `network_wide` BOOLEAN NOT NULL DEFAULT false,
    `payment_limit_percent` INTEGER NOT NULL DEFAULT 0,
    `payment_limit_fixed` BIGINT NOT NULL DEFAULT 0,
    `cashback_visible_in_app` BOOLEAN NOT NULL DEFAULT true,
    `burn_days` INTEGER NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `loyalty_card_types_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_cards` (
    `id` VARCHAR(32) NOT NULL,
    `card_type_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `number` VARCHAR(40) NOT NULL,
    `balance` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `loyalty_cards_number_key`(`number`),
    INDEX `loyalty_cards_business_id_client_id_idx`(`business_id`, `client_id`),
    INDEX `loyalty_cards_app_user_id_idx`(`app_user_id`),
    INDEX `loyalty_cards_card_type_id_idx`(`card_type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotions` (
    `id` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `card_type_ids` JSON NOT NULL,
    `value_type` VARCHAR(8) NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,
    `thresholds` JSON NULL,
    `service_scope` JSON NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `promotions_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_tx` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `source` VARCHAR(12) NOT NULL,
    `ref_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `amount` BIGINT NOT NULL DEFAULT 0,
    `booking_id` VARCHAR(32) NULL,
    `note` VARCHAR(400) NULL,
    `staff_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `loyalty_tx_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `loyalty_tx_client_id_idx`(`client_id`),
    INDEX `loyalty_tx_source_ref_id_idx`(`source`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `referral_programs` (
    `owner_id` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `giver_reward` BIGINT NOT NULL DEFAULT 0,
    `receiver_reward` BIGINT NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`owner_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `certificate_types` (
    `id` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `face_value` BIGINT NOT NULL,
    `valid_days` INTEGER NOT NULL,
    `network_wide` BOOLEAN NOT NULL DEFAULT false,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `certificate_types_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `certificates` (
    `id` VARCHAR(32) NOT NULL,
    `type_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `code` VARCHAR(40) NOT NULL,
    `total` BIGINT NOT NULL,
    `balance` BIGINT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `sold_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `certificates_code_key`(`code`),
    INDEX `certificates_business_id_client_id_idx`(`business_id`, `client_id`),
    INDEX `certificates_app_user_id_idx`(`app_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `membership_types` (
    `id` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `total_visits` INTEGER NULL,
    `price` BIGINT NOT NULL,
    `valid_days` INTEGER NOT NULL,
    `service_ids` JSON NOT NULL,
    `network_wide` BOOLEAN NOT NULL DEFAULT false,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `membership_types_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `membership_sales` (
    `id` VARCHAR(32) NOT NULL,
    `type_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `app_user_id` VARCHAR(32) NULL,
    `code` VARCHAR(40) NOT NULL,
    `total_visits` INTEGER NULL,
    `remaining_visits` INTEGER NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `sold_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `frozen_until` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `membership_sales_code_key`(`code`),
    INDEX `membership_sales_business_id_client_id_idx`(`business_id`, `client_id`),
    INDEX `membership_sales_app_user_id_idx`(`app_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `membership_freezes` (
    `id` VARCHAR(32) NOT NULL,
    `membership_id` VARCHAR(32) NOT NULL,
    `from_at` DATETIME(3) NOT NULL,
    `to_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `membership_freezes_membership_id_idx`(`membership_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_account_types` (
    `id` VARCHAR(32) NOT NULL,
    `owner_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `network_wide` BOOLEAN NOT NULL DEFAULT false,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `client_account_types_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_accounts` (
    `id` VARCHAR(32) NOT NULL,
    `type_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `balance` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `client_accounts_business_id_client_id_idx`(`business_id`, `client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_account_ops` (
    `id` VARCHAR(32) NOT NULL,
    `account_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `amount` BIGINT NOT NULL,
    `booking_id` VARCHAR(32) NULL,
    `note` VARCHAR(400) NULL,
    `staff_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `client_account_ops_account_id_idx`(`account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `loyalty_cards` ADD CONSTRAINT `loyalty_cards_card_type_id_fkey` FOREIGN KEY (`card_type_id`) REFERENCES `loyalty_card_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `certificates` ADD CONSTRAINT `certificates_type_id_fkey` FOREIGN KEY (`type_id`) REFERENCES `certificate_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `membership_sales` ADD CONSTRAINT `membership_sales_type_id_fkey` FOREIGN KEY (`type_id`) REFERENCES `membership_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `membership_freezes` ADD CONSTRAINT `membership_freezes_membership_id_fkey` FOREIGN KEY (`membership_id`) REFERENCES `membership_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_accounts` ADD CONSTRAINT `client_accounts_type_id_fkey` FOREIGN KEY (`type_id`) REFERENCES `client_account_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `client_account_ops` ADD CONSTRAINT `client_account_ops_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `client_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
