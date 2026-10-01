-- Сеть7: доступ пользователя сети по филиалам. NULL — все филиалы сети (и новые тоже), иначе JSON-массив id бизнесов.
ALTER TABLE `network_users` ADD COLUMN `business_ids` JSON NULL;
