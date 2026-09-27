-- CreateTable
CREATE TABLE `warehouses` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` VARCHAR(8) NOT NULL,
    `comment` VARCHAR(400) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `owner_staff_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `warehouses_business_id_location_id_order_idx`(`business_id`, `location_id`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_categories` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `parent_id` VARCHAR(32) NULL,
    `sku` VARCHAR(60) NULL,
    `comment` VARCHAR(400) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `product_categories_business_id_location_id_archived_idx`(`business_id`, `location_id`, `archived`),
    INDEX `product_categories_parent_id_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `category_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `receipt_name` VARCHAR(200) NULL,
    `sku` VARCHAR(60) NULL,
    `barcode` VARCHAR(64) NULL,
    `marking_code` VARCHAR(64) NULL,
    `sale_unit` VARCHAR(16) NOT NULL,
    `writeoff_unit` VARCHAR(16) NOT NULL,
    `unit_ratio` DOUBLE NOT NULL DEFAULT 1,
    `mass_net_g` INTEGER NULL,
    `mass_gross_g` INTEGER NULL,
    `sale_price` BIGINT NOT NULL DEFAULT 0,
    `cost_price` BIGINT NOT NULL DEFAULT 0,
    `tax_system` VARCHAR(10) NOT NULL DEFAULT 'default',
    `tax_rate` VARCHAR(10) NOT NULL DEFAULT 'default',
    `critical_stock` DOUBLE NOT NULL DEFAULT 0,
    `desired_stock` DOUBLE NOT NULL DEFAULT 0,
    `brand` VARCHAR(120) NULL,
    `shade` VARCHAR(80) NULL,
    `shade_color_index` INTEGER NULL,
    `expiry_date` DATETIME(3) NULL,
    `purchase_date` DATETIME(3) NULL,
    `shelf_life_after_open_days` INTEGER NULL,
    `show_to_clients` BOOLEAN NOT NULL DEFAULT false,
    `client_name` JSON NULL,
    `network_group_id` VARCHAR(32) NULL,
    `is_network_source` BOOLEAN NOT NULL DEFAULT false,
    `comment` VARCHAR(400) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `products_business_id_location_id_archived_idx`(`business_id`, `location_id`, `archived`),
    INDEX `products_category_id_idx`(`category_id`),
    INDEX `products_business_id_barcode_idx`(`business_id`, `barcode`),
    INDEX `products_network_group_id_idx`(`network_group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_ops` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `number` VARCHAR(20) NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `warehouse_id` VARCHAR(32) NOT NULL,
    `to_warehouse_id` VARCHAR(32) NULL,
    `counterparty_name` VARCHAR(160) NULL,
    `client_id` VARCHAR(32) NULL,
    `staff_id` VARCHAR(32) NULL,
    `service_id` VARCHAR(32) NULL,
    `booking_id` VARCHAR(32) NULL,
    `paid` BOOLEAN NOT NULL DEFAULT true,
    `payment_method` VARCHAR(10) NULL,
    `extra_lines` JSON NULL,
    `auto_writeoff` BOOLEAN NOT NULL DEFAULT false,
    `cancelled_at` DATETIME(3) NULL,
    `finance_operation_id` VARCHAR(32) NULL,
    `reason` VARCHAR(10) NULL,
    `comment` VARCHAR(400) NULL,
    `inventory_id` VARCHAR(32) NULL,
    `cancelled_by_doc_id` VARCHAR(32) NULL,
    `cancels_doc_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `stock_ops_business_id_location_id_date_idx`(`business_id`, `location_id`, `date`),
    INDEX `stock_ops_business_id_number_idx`(`business_id`, `number`),
    INDEX `stock_ops_booking_id_idx`(`booking_id`),
    INDEX `stock_ops_warehouse_id_idx`(`warehouse_id`),
    INDEX `stock_ops_inventory_id_idx`(`inventory_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_op_lines` (
    `id` VARCHAR(32) NOT NULL,
    `op_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `good_id` VARCHAR(32) NOT NULL,
    `qty_sale` DOUBLE NOT NULL,
    `unit_price` BIGINT NOT NULL,
    `discount_pct` INTEGER NULL,
    `cost_total` BIGINT NOT NULL,

    INDEX `stock_op_lines_op_id_idx`(`op_id`),
    INDEX `stock_op_lines_business_id_good_id_idx`(`business_id`, `good_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tech_cards` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `service_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `lines` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `tech_cards_business_id_location_id_idx`(`business_id`, `location_id`),
    UNIQUE INDEX `tech_cards_business_id_service_id_staff_id_key`(`business_id`, `service_id`, `staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventories` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `number` VARCHAR(20) NOT NULL,
    `warehouse_id` VARCHAR(32) NOT NULL,
    `category_id` VARCHAR(32) NULL,
    `date` DATETIME(3) NOT NULL,
    `comment` VARCHAR(400) NULL,
    `status` VARCHAR(8) NOT NULL DEFAULT 'draft',
    `lines` JSON NOT NULL,
    `writeoff_doc_id` VARCHAR(32) NULL,
    `income_doc_id` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `inventories_business_id_location_id_date_idx`(`business_id`, `location_id`, `date`),
    INDEX `inventories_warehouse_id_idx`(`warehouse_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `equipment` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `category` VARCHAR(80) NULL,
    `purchase_date` DATETIME(3) NOT NULL,
    `warranty_until` DATETIME(3) NULL,
    `service_interval_months` INTEGER NULL,
    `last_service_date` DATETIME(3) NULL,
    `replace_reminder_date` DATETIME(3) NULL,
    `comment` VARCHAR(400) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `equipment_business_id_location_id_archived_idx`(`business_id`, `location_id`, `archived`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_reminders` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NULL,
    `text` VARCHAR(500) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `stock_reminders_business_id_location_id_date_idx`(`business_id`, `location_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_settings` (
    `business_id` VARCHAR(32) NOT NULL,
    `cost_method` VARCHAR(20) NOT NULL DEFAULT 'lastPurchase',
    `forbid_on_shortage` BOOLEAN NOT NULL DEFAULT false,
    `expiry_warning_days` INTEGER NOT NULL DEFAULT 14,
    `ads_opt_in` BOOLEAN NOT NULL DEFAULT false,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,

    PRIMARY KEY (`business_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
