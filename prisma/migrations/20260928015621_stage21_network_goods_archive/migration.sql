-- CreateTable
CREATE TABLE `network_goods_archive` (
    `id` VARCHAR(32) NOT NULL,
    `network_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'good',
    `name` VARCHAR(200) NOT NULL,
    `archived_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `network_goods_archive_network_id_idx`(`network_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `network_goods_archive` ADD CONSTRAINT `network_goods_archive_network_id_fkey` FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
