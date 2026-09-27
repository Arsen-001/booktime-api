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
    super({ adapter: new PrismaMariaDb(url.toString()) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
