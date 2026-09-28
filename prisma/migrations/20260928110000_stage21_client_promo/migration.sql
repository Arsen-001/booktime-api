-- AlterTable
ALTER TABLE `news_posts` ADD COLUMN `moderation_item_id` VARCHAR(32) NULL,
    ADD COLUMN `paid_with_coins` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `photo_url` LONGTEXT NULL,
    ADD COLUMN `sent_at` DATETIME(3) NULL,
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'sent';

-- AlterTable
ALTER TABLE `story_bookings` ADD COLUMN `data` JSON NULL,
    ADD COLUMN `expires_at` DATETIME(3) NULL,
    ADD COLUMN `image_url` LONGTEXT NULL;

