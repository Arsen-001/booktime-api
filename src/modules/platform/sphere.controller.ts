import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { sphereCreateBody, sphereListQuery, sphereSaveBody } from './platform.schemas.js';
import { SphereRequestsService } from './sphere.service.js';

/** Наша панель: заявки на сферы (F-00-151/152, docs/backend/02 §19). */
@ApiTags('platform-sphere-requests')
@Controller('v1/platform/sphere-requests')
export class PlatformSphereController {
  constructor(private readonly sphere: SphereRequestsService) {}

  @Get()
  @Platform()
  list(@Query(new Zod(sphereListQuery)) q: z.infer<typeof sphereListQuery>) {
    return this.sphere.list(q.kind);
  }

  @Post()
  @Platform()
  create(@Body(new Zod(sphereCreateBody)) body: z.infer<typeof sphereCreateBody>) {
    return this.sphere.create(body);
  }

  @Put(':id')
  @Platform()
  save(@Param('id') id: string, @Body(new Zod(sphereSaveBody)) body: z.infer<typeof sphereSaveBody>) {
    return this.sphere.save(id, body);
  }
}
