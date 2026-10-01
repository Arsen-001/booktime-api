-- backend-2, заход 4 (qa/full-test-0930): продавец строки продажи склада (StockOpLine.sellerId, как sellerId мока).
-- «% с продаж» в зарплате и выручка по сотрудникам в отчётах берут продавца строки, иначе — продавца документа.
ALTER TABLE `stock_op_lines` ADD COLUMN `seller_id` VARCHAR(32) NULL;
