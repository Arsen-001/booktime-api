import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
function toSchema(schema) {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    return rest;
}
/** Тело запроса в OpenAPI из той же схемы zod, что проверяет вход (@Body(new Zod(schema))) — формы не расходятся */
export function ZodBody(schema) {
    return ApiBody({ schema: toSchema(schema) });
}
/** Ответ 200 в OpenAPI из схемы zod */
export function ZodOk(schema, description) {
    return applyDecorators(ApiOkResponse({ schema: toSchema(schema), description }));
}
//# sourceMappingURL=openapi.js.map