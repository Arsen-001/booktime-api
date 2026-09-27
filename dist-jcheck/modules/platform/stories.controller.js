var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Controller, Get, Put, Query, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Platform } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { StoriesService } from './stories.service.js';
import { storyBoardQuery, storyConfigBody, storyPlacesQuery } from './platform.schemas.js';
/** Наша панель: места сторис за монеты (F-00-159…162, docs/backend/02 §19). */
let PlatformStoriesController = class PlatformStoriesController {
    constructor(stories) {
        this.stories = stories;
    }
    config() {
        return this.stories.getConfig();
    }
    save(body) {
        return this.stories.saveConfig(body);
    }
    board(q) {
        return this.stories.getBoard(q.days, q.district);
    }
    places(q) {
        return this.stories.getPlaces(q.date, q.district);
    }
};
__decorate([
    Get('story-config'),
    Platform(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PlatformStoriesController.prototype, "config", null);
__decorate([
    Put('story-config'),
    Platform(),
    __param(0, Body(new Zod(storyConfigBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformStoriesController.prototype, "save", null);
__decorate([
    Get('story-board'),
    Platform(),
    __param(0, Query(new Zod(storyBoardQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformStoriesController.prototype, "board", null);
__decorate([
    Get('story-places'),
    Platform(),
    __param(0, Query(new Zod(storyPlacesQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PlatformStoriesController.prototype, "places", null);
PlatformStoriesController = __decorate([
    ApiTags('platform-stories'),
    Controller('v1/platform'),
    __metadata("design:paramtypes", [StoriesService])
], PlatformStoriesController);
export { PlatformStoriesController };
//# sourceMappingURL=stories.controller.js.map