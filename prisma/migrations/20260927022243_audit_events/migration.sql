-- CreateTable
CREATE TABLE `audit_events` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `network_id` VARCHAR(32) NULL,
    `actor_type` VARCHAR(16) NOT NULL,
    `actor_id` VARCHAR(32) NULL,
    `actor_name` VARCHAR(191) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` VARCHAR(32) NOT NULL,
    `diff` JSON NULL,
    `request_id` VARCHAR(64) NULL,
    `ip` VARCHAR(64) NULL,
    `device` VARCHAR(200) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_events_business_id_at_idx`(`business_id`, `at`),
    INDEX `audit_events_entity_type_entity_id_at_idx`(`entity_type`, `entity_id`, `at`),
    INDEX `audit_events_actor_id_at_idx`(`actor_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
