-- Журнал входов: канал кода (telegram | whatsapp | sms) — «Пользователи» нашей панели показывают, куда пришёл код
-- AlterTable
ALTER TABLE `login_events` ADD COLUMN `channel` VARCHAR(10) NULL;
