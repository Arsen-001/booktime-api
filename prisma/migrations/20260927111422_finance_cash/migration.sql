-- CreateTable
CREATE TABLE `cash_registers` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'cash',
    `opening_balance` BIGINT NOT NULL DEFAULT 0,
    `note` VARCHAR(400) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `system_generated` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `cash_registers_business_id_order_idx`(`business_id`, `order`),
    INDEX `cash_registers_location_id_idx`(`location_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_items` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `comment` VARCHAR(400) NULL,
    `system_key` VARCHAR(24) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payment_items_business_id_idx`(`business_id`),
    UNIQUE INDEX `payment_items_business_id_system_key_key`(`business_id`, `system_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_methods` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `key` VARCHAR(32) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'custom',
    `fee_percent` INTEGER NOT NULL DEFAULT 0,
    `account_id` VARCHAR(32) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payment_methods_business_id_order_idx`(`business_id`, `order`),
    UNIQUE INDEX `payment_methods_business_id_key_key`(`business_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fin_counterparties` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `type` VARCHAR(10) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `inn` VARCHAR(32) NULL,
    `phone` VARCHAR(16) NULL,
    `email` VARCHAR(160) NULL,
    `contact` VARCHAR(160) NULL,
    `note` VARCHAR(400) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `fin_counterparties_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fin_ops` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `account_id` VARCHAR(32) NOT NULL,
    `item_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `amount` BIGINT NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `method` VARCHAR(8) NOT NULL,
    `party_type` VARCHAR(12) NOT NULL DEFAULT 'none',
    `party_id` VARCHAR(32) NULL,
    `party_name` VARCHAR(160) NULL,
    `comment` VARCHAR(400) NULL,
    `source` VARCHAR(10) NOT NULL DEFAULT 'manual',
    `ref_id` VARCHAR(32) NULL,
    `doc_number` VARCHAR(20) NULL,
    `line_label` VARCHAR(160) NULL,
    `transfer_group_id` VARCHAR(32) NULL,
    `fee_operation_id` VARCHAR(32) NULL,
    `fee_of_operation_id` VARCHAR(32) NULL,
    `refund_of_id` VARCHAR(32) NULL,
    `refunded_amount` BIGINT NOT NULL DEFAULT 0,
    `cancelled` BOOLEAN NOT NULL DEFAULT false,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` VARCHAR(32) NULL,
    `history` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `fin_ops_business_id_date_idx`(`business_id`, `date`),
    INDEX `fin_ops_account_id_date_idx`(`account_id`, `date`),
    INDEX `fin_ops_item_id_idx`(`item_id`),
    INDEX `fin_ops_ref_id_idx`(`ref_id`),
    INDEX `fin_ops_transfer_group_id_idx`(`transfer_group_id`),
    INDEX `fin_ops_party_type_party_id_idx`(`party_type`, `party_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `finance_documents` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `number` VARCHAR(20) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `type` VARCHAR(10) NOT NULL,
    `content_kind` VARCHAR(12) NULL,
    `amount` BIGINT NOT NULL,
    `ref_operation_id` VARCHAR(32) NULL,
    `ref_booking_id` VARCHAR(32) NULL,
    `note` VARCHAR(400) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `finance_documents_business_id_date_idx`(`business_id`, `date`),
    INDEX `finance_documents_ref_booking_id_idx`(`ref_booking_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_payments` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `booking_id` VARCHAR(32) NOT NULL,
    `service_index` INTEGER NULL,
    `kind` VARCHAR(10) NOT NULL DEFAULT 'money',
    `method_key` VARCHAR(32) NOT NULL,
    `method_label` VARCHAR(80) NOT NULL,
    `account_id` VARCHAR(32) NULL,
    `amount` BIGINT NOT NULL,
    `fin_op_id` VARCHAR(32) NULL,
    `cancelled` BOOLEAN NOT NULL DEFAULT false,
    `cancelled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `booking_payments_business_id_booking_id_idx`(`business_id`, `booking_id`),
    INDEX `booking_payments_fin_op_id_idx`(`fin_op_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
