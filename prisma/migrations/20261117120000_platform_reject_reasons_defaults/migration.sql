-- Причины отказа модерации по умолчанию (хвосты 17.11): на живом сервере справочник был пуст — «Отклонить —
-- выбрать причину» показывал «Пока пусто», а шторка требовала причину: отклонить было нельзя. Те же шесть причин,
-- что видел владелец на демо (мок src/mock/slices/platform.ts → REASON_LABELS). Только если справочник ещё пуст —
-- свои причины команды не трогаем.
INSERT INTO `reject_reasons` (`id`, `label`, `active`, `order`)
SELECT * FROM (
  SELECT 'rr_default_1' AS id, JSON_OBJECT('ru', 'Плохое качество фото', 'en', 'Poor photo quality', 'hy', 'Լուսանկարի վատ որակ') AS label, TRUE AS active, 1 AS `order`
  UNION ALL SELECT 'rr_default_2', JSON_OBJECT('ru', 'Чужая или найденная в интернете фотография', 'en', 'Not the business’s own photo', 'hy', 'Ուրիշի կամ համացանցից վերցված լուսանկար'), TRUE, 2
  UNION ALL SELECT 'rr_default_3', JSON_OBJECT('ru', 'В тексте есть контакты или ссылка на сторонний сервис', 'en', 'Text contains outside contacts or links', 'hy', 'Տեքստում կան կոնտակտներ կամ հղում այլ ծառայության'), TRUE, 3
  UNION ALL SELECT 'rr_default_4', JSON_OBJECT('ru', 'Услуга не подходит для сферы салона', 'en', 'Service does not match the business’s sphere', 'hy', 'Ծառայությունը չի համապատասխանում սրահի ոլորտին'), TRUE, 4
  UNION ALL SELECT 'rr_default_5', JSON_OBJECT('ru', 'Оскорбительное или запрещённое содержание', 'en', 'Offensive or prohibited content', 'hy', 'Վիրավորական կամ արգելված բովանդակություն'), TRUE, 5
  UNION ALL SELECT 'rr_default_6', JSON_OBJECT('ru', 'Диплом не читается или выдан не на это имя', 'en', 'Diploma is unreadable or issued to another name', 'hy', 'Դիպլոմը չի ընթերցվում կամ տրված է այլ անունով'), TRUE, 6
) AS defaults
WHERE NOT EXISTS (SELECT 1 FROM `reject_reasons`);
