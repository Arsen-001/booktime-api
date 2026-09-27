import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { PlatformNotesService } from './notes.service.js';
import { platformNotesBody } from './platform.schemas.js';

/** Наша панель: заметки основателя — план запуска, окупаемость, имя (01 §8, docs/backend/02 §19). */
@ApiTags('platform-notes')
@Controller('v1/platform/notes')
export class PlatformNotesController {
  constructor(private readonly notes: PlatformNotesService) {}

  @Get()
  @Platform()
  get() {
    return this.notes.getDoc();
  }

  @Put()
  @Platform()
  save(@Body(new Zod(platformNotesBody)) body: z.infer<typeof platformNotesBody>) {
    return this.notes.saveDoc(body);
  }

  @Get('paying-now')
  @Platform()
  payingNow() {
    return this.notes.getPayingNow();
  }
}
