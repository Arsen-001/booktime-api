-- Владелец 01.10.2026 (qa/full-test-0930, агент stock): язык сообщений поставщику — заказ со склада в WhatsApp
-- (Counterparty.messageLang фронта: hy | ru | en; NULL — язык кабинета).
ALTER TABLE `fin_counterparties` ADD COLUMN `message_lang` VARCHAR(2) NULL;
