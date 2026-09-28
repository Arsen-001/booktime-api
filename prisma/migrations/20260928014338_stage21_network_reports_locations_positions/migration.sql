-- CreateTable
CREATE TABLE `network_location_order` (
    `network_id` VARCHAR(32) NOT NULL,
    `ordered_ids` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`network_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `network_position_defs` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `requirements` JSON NOT NULL,
    `network_only` BOOLEAN NOT NULL DEFAULT false,
    `business_ids` JSON NOT NULL,
    `services_mode` VARCHAR(12) NOT NULL DEFAULT 'off',
    `service_ids` JSON NOT NULL,
    `keep_price_and_duration` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `network_position_defs_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `network_location_order` ADD CONSTRAINT `network_location_order_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `network_position_defs` ADD CONSTRAINT `network_position_defs_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
