-- 04.10.2026: документы клиентов — в закрытое хранилище вместо data: URL (старые строки остаются как были);
-- uploads.mime длиннее (типы Office); индекс для ночной уборки неиспользуемых файлов;
-- «Войти через Apple»: зашифрованный refresh token — отозвать вход при удалении аккаунта (App Store 5.1.1(v)).

-- AlterTable
ALTER TABLE `client_files` ADD COLUMN `mime` VARCHAR(120) NULL,
    ADD COLUMN `storage_key` VARCHAR(200) NULL,
    MODIFY `data_url` LONGTEXT NULL;

-- AlterTable
ALTER TABLE `uploads` MODIFY `mime` VARCHAR(120) NOT NULL;

-- AlterTable
ALTER TABLE `user_identities` ADD COLUMN `refresh_token_enc` TEXT NULL,
    ADD COLUMN `token_client_id` VARCHAR(255) NULL;

-- CreateIndex
CREATE INDEX `client_files_storage_key_idx` ON `client_files`(`storage_key`);

-- CreateIndex
CREATE INDEX `uploads_created_at_idx` ON `uploads`(`created_at`);
