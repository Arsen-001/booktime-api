import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from './config/env.js';

/** Один клиент базы на процесс. Соединение в UTC (PLAN.md §4.1): время в базе всегда UTC. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const url = new URL(env.DATABASE_URL);
    url.searchParams.set('timezone', 'Z');
    // MySQL 8+ (caching_sha2_password) без TLS: после перезапуска базы драйвер не может войти, пока сам не попросит
    // открытый ключ сервера («RSA public key is not available client side») — так падали и локальный докер, и Railway
    // (база в частной сети railway.internal). Разрешаем запрос ключа, если адрес базы не запретил его явно.
    if (!url.searchParams.has('allowPublicKeyRetrieval')) url.searchParams.set('allowPublicKeyRetrieval', 'true');
    super({ adapter: new PrismaMariaDb(url.toString()) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
