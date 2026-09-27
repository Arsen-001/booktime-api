import type { Prisma } from '../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/**
 * Следующий номер общей последовательности панели (сейчас — только 'support', F-00-182: SupportTicket и
 * BizRequest(kind=help) делят одну нумерацию очереди). Атомарно под транзакцией — upsert + инкремент строки.
 */
export async function nextPlatformNumber(tx: Tx, key: string): Promise<number> {
  await tx.platformCounter.upsert({ where: { key }, create: { key, value: 0 }, update: {} });
  await tx.$executeRaw`UPDATE platform_counters SET value = value + 1 WHERE \`key\` = ${key}`;
  const row = await tx.platformCounter.findUniqueOrThrow({ where: { key } });
  return row.value;
}
