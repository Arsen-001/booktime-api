import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiError } from '../errors/api-error.js';

/**
 * Проверка входа схемой zod: @Body(new Zod(schema)). Ошибка — 400 { code: 'validation', fields: { путь: причина } },
 * экран подсвечивает поля по ключам.
 */
@Injectable()
export class Zod<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    throw new ApiError('validation', 'Invalid input', fields);
  }
}
