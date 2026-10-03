-- Файлы и фото (04.10.2026): загруженные фото — в хранилище (диск UPLOADS_DIR или S3), здесь — владелец, размер, квота
-- CreateTable
CREATE TABLE `uploads` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NULL,
    `user_id` VARCHAR(32) NULL,
    `key` VARCHAR(200) NOT NULL,
    `mime` VARCHAR(40) NOT NULL,
    `bytes` INTEGER NOT NULL,
    `width` INTEGER NOT NULL,
    `height` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    UNIQUE INDEX `uploads_key_key`(`key`),
    INDEX `uploads_business_id_created_at_idx`(`business_id`, `created_at`),
    INDEX `uploads_user_id_created_at_idx`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
