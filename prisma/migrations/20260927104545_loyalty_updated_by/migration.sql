-- AlterTable
ALTER TABLE `certificates` ADD COLUMN `updated_by` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `client_accounts` ADD COLUMN `updated_by` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `loyalty_cards` ADD COLUMN `updated_by` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `membership_sales` ADD COLUMN `updated_by` VARCHAR(32) NULL;
