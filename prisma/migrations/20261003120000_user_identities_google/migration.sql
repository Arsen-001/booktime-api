-- «Войти через Google» (03.10.2026): привязки внешних входов к человеку
-- CreateTable
CREATE TABLE `user_identities` (
    `id` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(16) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `email` VARCHAR(254) NULL,
    `user_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,

    UNIQUE INDEX `user_identities_provider_subject_key`(`provider`, `subject`),
    UNIQUE INDEX `user_identities_user_id_provider_key`(`user_id`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_identities` ADD CONSTRAINT `user_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
