import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Наша команда (этап 21): список людей для выпадающих «ответственный» в панели (визиты, карточка бизнеса,
 * подключение салона). Команда = `PlatformMember` (вход Р11), имя — из `User.name`. Отключённые не показываем.
 */
@ApiTags('platform-team')
@Controller('v1/platform/team')
export class PlatformTeamController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Platform()
  @ApiOperation({ summary: 'Команда платформы: id + имя (F-00-177, выпадающие «ответственный»)' })
  async list(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.prisma.platformMember.findMany({
      where: { disabledAt: null },
      select: { id: true, login: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.user.name || r.login }));
  }
}
