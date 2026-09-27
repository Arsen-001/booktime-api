import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { RequestContext } from '../http/context.js';
import { Ctx } from '../http/guards.js';
import { UndoService } from './undo.service.js';

@ApiTags('system')
@Controller('v1/undo')
export class UndoController {
  constructor(private readonly undo: UndoService) {}

  /** Откатить действие по токену «Отменить» (действует 10 с) */
  @Post(':token')
  @HttpCode(204)
  @ApiNoContentResponse()
  async run(@Param('token') token: string, @Ctx() ctx: RequestContext): Promise<void> {
    await this.undo.undo(token, ctx);
  }
}
