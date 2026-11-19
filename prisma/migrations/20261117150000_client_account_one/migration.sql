-- Один личный счёт клиента — в лояльности (владелец 17.11.2026, DESIGN.md «Ответы на вопросы полного прохода» №25).
-- Деньги, лежащие в старом «Баланс и оплаты» (пополнения кассой − возвраты − оплаты визитов счётом, считались на лету),
-- переносим на счёт лояльности клиента в том же салоне: есть счёт — на самый старый, нет — открываем по первому типу
-- счёта салона (нет типа — заводим «Личный счёт»). Перенос — одна операция счёта «пополнение» (минус — «списание»).
-- Старые строки помечаем перенесёнными (пополнения/возвраты: ref_id = операция переноса; оплаты счётом:
-- loyalty_account_id = счёт), поэтому старый баланс становится 0 — деньги не теряются и не удваиваются.
-- id — от SHA2 (в MySQL 9 нет MD5/SHA1). Пример: Ани в Nuri — 10 000 в «Балансе» + 21 000 на «Депозите» → один счёт 31 000 ֏. Повторный запуск ничего не делает.

CREATE TEMPORARY TABLE mig25_old AS
SELECT x.business_id, x.client_id, CAST(SUM(x.amount) AS SIGNED) AS balance
FROM (
  SELECT o.business_id, o.party_id AS client_id, CASE WHEN pi.system_key = 'accountTopUp' THEN o.amount ELSE -o.amount END AS amount
  FROM fin_ops o JOIN payment_items pi ON pi.id = o.item_id
  WHERE o.party_type = 'client' AND o.source = 'account' AND o.cancelled = 0 AND o.ref_id IS NULL
    AND pi.system_key IN ('accountTopUp', 'refund') AND o.party_id IS NOT NULL
  UNION ALL
  SELECT p.business_id, b.client_id, -(p.amount - p.refunded_amount)
  FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
  WHERE p.kind = 'account' AND p.cancelled = 0 AND p.loyalty_account_id IS NULL AND b.client_id IS NOT NULL
) x
GROUP BY x.business_id, x.client_id;

-- Тип счёта салона для тех, у кого его нет
INSERT INTO client_account_types (id, owner_id, business_id, name, network_wide, archived, created_at, updated_at, created_by, updated_by, version)
SELECT CONCAT('mig25t', SUBSTRING(SHA2(m.business_id, 256), 1, 26)), m.business_id, m.business_id, 'Личный счёт', 0, 0, NOW(3), NOW(3), 'system', 'system', 1
FROM (SELECT DISTINCT business_id FROM mig25_old) m
WHERE NOT EXISTS (SELECT 1 FROM client_account_types t WHERE t.business_id = m.business_id AND t.archived = 0);

-- Счёт клиента для тех, у кого его нет
INSERT INTO client_accounts (id, type_id, business_id, client_id, balance, created_at, updated_at, created_by, updated_by, version)
SELECT CONCAT('mig25a', SUBSTRING(SHA2(CONCAT(m.business_id, '|', m.client_id), 256), 1, 26)),
  (SELECT t.id FROM client_account_types t WHERE t.business_id = m.business_id AND t.archived = 0 ORDER BY t.created_at, t.id LIMIT 1),
  m.business_id, m.client_id, 0, NOW(3), NOW(3), 'system', 'system', 1
FROM mig25_old m
WHERE m.balance <> 0 AND NOT EXISTS (SELECT 1 FROM client_accounts a WHERE a.business_id = m.business_id AND a.client_id = m.client_id);

-- Куда переносим: самый старый счёт клиента в салоне
CREATE TEMPORARY TABLE mig25_target AS
SELECT m.business_id, m.client_id, m.balance,
  (SELECT a.id FROM client_accounts a WHERE a.business_id = m.business_id AND a.client_id = m.client_id ORDER BY a.created_at, a.id LIMIT 1) AS account_id,
  CONCAT('mig25o', SUBSTRING(SHA2(CONCAT(m.business_id, '|', m.client_id, '|op'), 256), 1, 26)) AS op_id
FROM mig25_old m
WHERE m.balance <> 0;

INSERT INTO client_account_ops (id, account_id, kind, amount, note, staff_id, created_at)
SELECT t.op_id, t.account_id, CASE WHEN t.balance > 0 THEN 'topup' ELSE 'charge' END, ABS(t.balance), 'Перенос из «Баланс и оплаты»', NULL, NOW(3)
FROM mig25_target t;

UPDATE client_accounts a JOIN mig25_target t ON t.account_id = a.id
SET a.balance = a.balance + t.balance, a.version = a.version + 1, a.updated_at = NOW(3);

-- Старые строки — перенесены (старый баланс = 0)
UPDATE fin_ops o JOIN payment_items pi ON pi.id = o.item_id JOIN mig25_target t ON t.business_id = o.business_id AND t.client_id = o.party_id
SET o.ref_id = t.op_id
WHERE o.party_type = 'client' AND o.source = 'account' AND o.cancelled = 0 AND o.ref_id IS NULL AND pi.system_key IN ('accountTopUp', 'refund');

UPDATE booking_payments p JOIN bookings b ON b.id = p.booking_id JOIN mig25_target t ON t.business_id = p.business_id AND t.client_id = b.client_id
SET p.loyalty_account_id = t.account_id
WHERE p.kind = 'account' AND p.cancelled = 0 AND p.loyalty_account_id IS NULL;

DROP TEMPORARY TABLE mig25_target;
DROP TEMPORARY TABLE mig25_old;
