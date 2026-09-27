-- CreateTable
CREATE TABLE `payroll_settings` (
    `location_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `accrual_date_basis` VARCHAR(8) NOT NULL DEFAULT 'visit',
    `bank_commission_split` VARCHAR(20) NOT NULL DEFAULT 'businessOnly',
    `assist_compensation_enabled` BOOLEAN NOT NULL DEFAULT false,
    `multiple_assistants_allowed` BOOLEAN NOT NULL DEFAULT false,
    `assistant_split_rule` VARCHAR(10) NOT NULL DEFAULT 'shared',
    `payroll_model` VARCHAR(10) NOT NULL DEFAULT 'simplified',
    `statement_approval_enabled` BOOLEAN NOT NULL DEFAULT false,
    `payroll_fund_target_pct` INTEGER NOT NULL DEFAULT 30,
    `payroll_fund_warn_pct` INTEGER NOT NULL DEFAULT 40,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payroll_settings_business_id_idx`(`business_id`),
    PRIMARY KEY (`location_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_schemes` (
    `staff_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payroll_schemes_business_id_idx`(`business_id`),
    PRIMARY KEY (`staff_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_rules` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payroll_rules_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_criteria` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `period` VARCHAR(5) NOT NULL DEFAULT 'month',
    `metric` VARCHAR(10) NOT NULL DEFAULT 'turnover',
    `scope` VARCHAR(10) NOT NULL DEFAULT 'staff',
    `by_services` BOOLEAN NOT NULL DEFAULT true,
    `by_products` BOOLEAN NOT NULL DEFAULT false,
    `threshold` BIGINT NOT NULL DEFAULT 0,
    `include_discounts` BOOLEAN NOT NULL DEFAULT true,
    `count_category_ids` JSON NOT NULL,
    `count_item_ids` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payroll_criteria_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_charts` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` VARCHAR(10) NOT NULL DEFAULT 'standard',
    `standard_rule_id` VARCHAR(32) NULL,
    `plan_rows` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(32) NULL,
    `updated_by` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `payroll_charts_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_chart_assignments` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `chart_id` VARCHAR(32) NOT NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `start_date` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `payroll_chart_assignments_business_id_staff_id_start_date_idx`(`business_id`, `staff_id`, `start_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bonus_penalty_types` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(7) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `default_amount` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bonus_penalty_types_business_id_idx`(`business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_settlement_entries` (
    `id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `location_id` VARCHAR(32) NULL,
    `staff_id` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `amount` BIGINT NOT NULL DEFAULT 0,
    `label` VARCHAR(200) NOT NULL,
    `comment` VARCHAR(400) NULL,
    `period_from` DATETIME(3) NULL,
    `period_to` DATETIME(3) NULL,
    `operation_id` VARCHAR(32) NULL,
    `status` VARCHAR(8) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(32) NULL,

    INDEX `payroll_settlement_entries_business_id_staff_id_created_at_idx`(`business_id`, `staff_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_statement_approvals` (
    `sheet_id` VARCHAR(32) NOT NULL,
    `business_id` VARCHAR(32) NOT NULL,
    `status` VARCHAR(14) NOT NULL DEFAULT 'pendingReview',
    `history` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_statement_approvals_business_id_idx`(`business_id`),
    PRIMARY KEY (`sheet_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
