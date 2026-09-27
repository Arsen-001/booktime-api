import { Controller, Get, Put, Query, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { StoriesService } from './stories.service.js';
import { storyBoardQuery, storyConfigBody, storyPlacesQuery } from './platform.schemas.js';

/** Наша панель: места сторис за монеты (F-00-159…162, docs/backend/02 §19). */
@ApiTags('platform-stories')
@Controller('v1/platform')
export class PlatformStoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Get('story-config')
  @Platform()
  config() {
    return this.stories.getConfig();
  }

  @Put('story-config')
  @Platform()
  save(@Body(new Zod(storyConfigBody)) body: z.infer<typeof storyConfigBody>) {
    return this.stories.saveConfig(body);
  }

  @Get('story-board')
  @Platform()
  board(@Query(new Zod(storyBoardQuery)) q: z.infer<typeof storyBoardQuery>) {
    return this.stories.getBoard(q.days, q.district);
  }

  @Get('story-places')
  @Platform()
  places(@Query(new Zod(storyPlacesQuery)) q: z.infer<typeof storyPlacesQuery>) {
    return this.stories.getPlaces(q.date, q.district);
  }
}
