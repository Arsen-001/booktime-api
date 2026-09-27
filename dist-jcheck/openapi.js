import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './bootstrap.js';
/** Записать спецификацию в openapi/openapi.json — из неё фронт генерирует типы (openapi-typescript), PLAN.md §2 */
const { app, openapi } = await createApp();
const out = path.resolve('openapi/openapi.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(openapi, null, 2)}\n`);
console.log(`OpenAPI → ${out} (путей: ${Object.keys(openapi.paths).length})`);
await app.close();
//# sourceMappingURL=openapi.js.map