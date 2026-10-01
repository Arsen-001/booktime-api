-- «Пригласи подругу» (01.10.2026): личные коды клиентов и привязка нового клиента к пригласившему

-- CreateTable
CREATE TABLE `referral_codes` (
    `code` VARCHAR(12) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `client_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `referral_codes_client_id_key`(`client_id`),
    INDEX `referral_codes_business_id_idx`(`business_id`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `client_referrals` (
    `invitee_client_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `referrer_client_id` VARCHAR(32) NOT NULL,
    `code` VARCHAR(12) NOT NULL,
    `booking_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `client_referrals_business_id_referrer_client_id_idx`(`business_id`, `referrer_client_id`),
    INDEX `client_referrals_referrer_client_id_idx`(`referrer_client_id`),
    PRIMARY KEY (`invitee_client_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
