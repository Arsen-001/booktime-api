import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestContext } from '../../common/http/context.js';
import { Ctx, Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { userBlockBody, usersListQuery, type UserBlockBody, type UsersListQuery } from './users.schemas.js';
import { PlatformUsersService } from './users.service.js';

/**
 * Наша панель → «Пользователи» (03.10.2026): все зарегистрированные люди. Смотреть — любой из команды платформы,
 * блокировать и завершать сессии — только роль admin (проверка в сервисе). Каждое действие — в журнал аудита.
 */
@ApiTags('platform-users')
@Controller('v1/platform/users')
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get()
  @Platform()
  @ApiOperation({ summary: 'Люди: поиск (имя, телефон), фильтры, сортировка, страница; счётчики сверху. Телефон — с маской' })
  list(@Query(new Zod(usersListQuery)) q: UsersListQuery) {
    return this.users.list(q);
  }

  @Get(':id')
  @Platform()
  @ApiOperation({ summary: 'Карточка человека: профиль, роли, Telegram, Google, записи, входы (IP с маской), активные сессии' })
  card(@Param('id') id: string) {
    return this.users.card(id);
  }

  @Post(':id/block')
  @Platform()
  @ApiOperation({ summary: 'Заблокировать (причина обязательна; все сессии отзываются) / разблокировать. Только admin команды' })
  block(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(userBlockBody)) body: UserBlockBody) {
    return this.users.setBlocked(ctx, id, body);
  }

  @Post(':id/sessions/revoke')
  @Platform()
  @ApiOperation({ summary: 'Завершить все сессии человека. Только admin команды' })
  revokeSessions(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.users.revokeSessions(ctx, id);
  }
}
