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
import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { createRedis } from '../redis.js';
import { REDIS } from '../tokens.js';
const PREFIX = 'live:';
let LiveService = class LiveService {
    constructor(redis) {
        this.redis = redis;
        this.sub = createRedis('live-sub');
        this.listeners = new Map();
        this.sub.on('message', (channel, message) => {
            const set = this.listeners.get(channel.slice(PREFIX.length));
            if (!set)
                return;
            const event = JSON.parse(message);
            for (const fn of set)
                fn(event);
        });
    }
    async publish(channel, event) {
        await this.redis.publish(PREFIX + channel, JSON.stringify(event));
    }
    /** Поток событий по списку каналов; отписка — при отписке от Observable (закрыли вкладку) */
    stream(channels) {
        return new Observable((subscriber) => {
            const fns = channels.map((channel) => {
                const fn = (event) => subscriber.next({ channel, event });
                let set = this.listeners.get(channel);
                if (!set) {
                    set = new Set();
                    this.listeners.set(channel, set);
                    void this.sub.subscribe(PREFIX + channel);
                }
                set.add(fn);
                return [channel, fn];
            });
            return () => {
                for (const [channel, fn] of fns) {
                    const set = this.listeners.get(channel);
                    set?.delete(fn);
                    if (set && set.size === 0) {
                        this.listeners.delete(channel);
                        void this.sub.unsubscribe(PREFIX + channel);
                    }
                }
            };
        });
    }
    async onModuleDestroy() {
        await this.sub.quit();
    }
};
LiveService = __decorate([
    Injectable(),
    __param(0, Inject(REDIS)),
    __metadata("design:paramtypes", [Function])
], LiveService);
export { LiveService };
//# sourceMappingURL=live.service.js.map