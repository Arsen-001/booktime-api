-- Заказы (03.10.2026): ателье, ремонт, химчистка, детейлинг — приём заказа, статусы, «готов» клиенту, ссылка /o/<code>
-- AlterTable
ALTER TABLE `businesses` ADD COLUMN `orders_enabled` BOOLEAN NULL;

-- CreateTable
CREATE TABLE `orders` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `number` INTEGER NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `client_id` VARCHAR(32) NULL,
    `client_name` VARCHAR(160) NOT NULL,
    `client_phone` VARCHAR(16) NOT NULL,
    `items` JSON NOT NULL,
    `photos` JSON NOT NULL,
    `staff_id` VARCHAR(32) NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'received',
    `due_date` VARCHAR(10) NULL,
    `price` INTEGER NOT NULL DEFAULT 0,
    `prepaid` INTEGER NOT NULL DEFAULT 0,
    `comment` VARCHAR(2000) NULL,
    `history` JSON NOT NULL,
    `ready_notified_at` DATETIME(3) NULL,
    `issued_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_code_key`(`code`),
    INDEX `orders_business_id_status_created_at_idx`(`business_id`, `status`, `created_at`),
    INDEX `orders_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `orders_client_id_idx`(`client_id`),
    UNIQUE INDEX `orders_business_id_number_key`(`business_id`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_counters` (
    `business_id` VARCHAR(32) NOT NULL,
    `last_number` INTEGER NOT NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
