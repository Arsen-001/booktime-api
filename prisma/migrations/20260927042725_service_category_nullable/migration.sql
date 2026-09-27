-- DropForeignKey
ALTER TABLE `services` DROP FOREIGN KEY `services_category_id_fkey`;

-- AlterTable
ALTER TABLE `services` MODIFY `category_id` VARCHAR(32) NULL;

-- AddForeignKey
ALTER TABLE `services` ADD CONSTRAINT `services_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `service_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
