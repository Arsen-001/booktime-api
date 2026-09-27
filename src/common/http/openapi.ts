import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

type JsonSchema = Record<string, unknown>;

function toSchema(schema: ZodType): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return rest;
}

/** Тело запроса в OpenAPI из той же схемы zod, что проверяет вход (@Body(new Zod(schema))) — формы не расходятся */
export function ZodBody(schema: ZodType) {
  return ApiBody({ schema: toSchema(schema) as never });
}

/** Ответ 200 в OpenAPI из схемы zod */
export function ZodOk(schema: ZodType, description?: string) {
  return applyDecorators(ApiOkResponse({ schema: toSchema(schema) as never, description }));
}
