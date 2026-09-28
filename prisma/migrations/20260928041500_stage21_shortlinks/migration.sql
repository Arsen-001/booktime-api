-- Этап 21, 28.09: короткие ссылки SMS booktime.am/s/<code> (ShortLink).
CREATE TABLE `short_links` (
    `code` VARCHAR(12) NOT NULL,
    `target` VARCHAR(512) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NULL,

    UNIQUE INDEX `short_links_business_id_target_key`(`business_id`, `target`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
