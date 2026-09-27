var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../errors/api-error.js';
/**
 * Проверка входа схемой zod: @Body(new Zod(schema)). Ошибка — 400 { code: 'validation', fields: { путь: причина } },
 * экран подсвечивает поля по ключам.
 */
let Zod = class Zod {
    constructor(schema) {
        this.schema = schema;
    }
    transform(value) {
        const parsed = this.schema.safeParse(value);
        if (parsed.success)
            return parsed.data;
        const fields = {};
        for (const issue of parsed.error.issues) {
            const key = issue.path.join('.') || '_';
            fields[key] ??= issue.message;
        }
        throw new ApiError('validation', 'Invalid input', fields);
    }
};
Zod = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [Function])
], Zod);
export { Zod };
//# sourceMappingURL=validation.js.map