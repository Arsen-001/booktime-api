import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma.service.js';
import { REDIS } from '../../common/tokens.js';

class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] }) status!: 'ok' | 'degraded';
  @ApiProperty() db!: boolean;
  @ApiProperty() redis!: boolean;
  @ApiProperty({ description: 'Время сервера, UTC ISO' }) time!: string;
}

/** Жив ли сервер и его зависимости (для docker/хостинга и ensure-скриптов) */
@ApiTags('system')
@Controller('v1/health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOkResponse({ type: HealthDto })
  async health(): Promise<HealthDto> {
    const db = await this.prisma.$queryRawUnsafe('SELECT 1').then(() => true, () => false);
    const redis = await this.redis.ping().then((r) => r === 'PONG', () => false);
    return { status: db && redis ? 'ok' : 'degraded', db, redis, time: new Date().toISOString() };
  }
}
