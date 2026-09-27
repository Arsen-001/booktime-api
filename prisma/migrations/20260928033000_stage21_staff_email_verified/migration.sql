-- Этап 21 «Сдача», лейн rest: F-15-150 — подтверждение почты сотрудника (settings.ts::sendEmailConfirmation/confirmEmailLinkDemo).
ALTER TABLE `staff` ADD COLUMN `email_verified` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `email_confirm_sent_at` DATETIME(3) NULL;
