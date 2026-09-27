-- Этап 21 «notify+integrations»: F-05-090 — типы уведомлений, отключённые клиентом самим.
ALTER TABLE `client_notify_prefs` ADD COLUMN `disabled_type_codes` JSON NULL;
